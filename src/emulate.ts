import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import { crc32 } from 'hash-wasm';
import * as shelljs from 'shelljs';
import * as ffmpeg from 'fluent-ffmpeg';
import { values, first, size, last, isEqual } from 'lodash';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

import { executeFrame, InputState, loadRom as loadGame, loadState, Recording, rgb565toRaw, saveState } from './util';
import sharp = require('sharp');

tmp.setGracefulCleanup();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 20;
const MINIMUM_FRAMES = 60;

interface AutoplayInputState extends InputState {
    autoplay?: boolean
}

const TEST_INPUTS: AutoplayInputState[] = [
    { A: true, autoplay: true },
    { B: true, autoplay: false },
    // { START: true },
    // { SELECT: true },
    { DOWN: true, autoplay: true },
    { UP: true, autoplay: true },
    { LEFT: true, autoplay: true },
    { RIGHT: true, autoplay: true }
];

export enum CoreType {
    NES = 'nes',
    SNES = 'snes',
    GB = 'gb',
    GBA = 'gba'
}

const NesCore = require('../cores/quicknes_libretro');
const SnesCore = require('../cores/snes9x2010_libretro');
const GbCore = require('../cores/mgba_libretro');

export const emulate = async (coreType: CoreType, game: ArrayBufferLike, state: ArrayBufferLike, playerInputs: InputState[], core?: any) => {
    if (!core) {
        switch (coreType) {
            case CoreType.NES:
                core = await NesCore();
                break;
            case CoreType.SNES:
                core = await SnesCore();
                break;
            case CoreType.GBA:
            case CoreType.GB:
                core = await GbCore();
                break;
            default:
                throw new Error(`Unknow core type: ${coreType}`);
        }

        core.retro_set_environment((cmd: number, data: any) => {
            if (cmd == 3) {
                core.HEAPU8[data] = 1;
                return true;
            }

            if (cmd == (51 | 0x10000)) {
                return true;
            }

            if (cmd == 10) {
                return true;
            }

            return false;
        });

        loadGame(core, game);

        if (state) {
            loadState(core, state);
        }
    }

    const system_info = {};
    const av_info: any = {};

    core.retro_get_system_info(system_info);
    core.retro_get_system_av_info(av_info);

    const recording: Recording = {
        tmpDir: tmp.dirSync().name,
        maxFramerate: av_info.timing_fps / RECORDING_FRAMERATE,
        executedFrameCount: 0,
        frames: [],
        lastFrame: undefined,
        lastRecordedBufferHash: null,
        framesSinceRecord: -1,
        width: av_info.geometry_base_width * 2,
        height: av_info.geometry_base_height * 2,
        quality: 100
    };

    for (let i = 0; i < playerInputs.length; i++) {
        const prev = playerInputs[i - 1];
        const current = playerInputs[i];
        const next = playerInputs[i + 1];

        if (isDirection(current) && (isEqual(current, next) || isEqual(current, prev))) {
            await executeFrame(core, current, recording, 20);
        } else {
            await executeFrame(core, current, recording, 4);
            await executeFrame(core, {}, recording, 16);
        }
    }

    const endFrameCount = recording.executedFrameCount + 30 * 60;
    test: while (recording.executedFrameCount < endFrameCount) {
        await executeFrame(core, {}, recording, 32);

        const state = saveState(core);

        const possibilities: { [hash: string]: AutoplayInputState } = {};

        await executeFrame(core, {}, null, 4);
        const controlResult = await crc32((await executeFrame(core, {}, null, 20)).buffer);

        for (const testInput of TEST_INPUTS) {
            loadState(core, state);

            await executeFrame(core, testInput, null, 4)
            const testResult = await crc32((await executeFrame(core, {}, null, 20)).buffer);

            if (controlResult != testResult) {
                if (possibilities[testResult] && testInput.autoplay) {
                    possibilities[testResult] = testInput;
                } else if (!possibilities[testResult]) {
                    possibilities[testResult] = testInput;
                }
            }

            if (size(possibilities) > 1) {
                loadState(core, state);
                break test;
            }
        }

        const possibleAutoplay = first(values(possibilities));

        const autoplay = size(possibilities) == 1 && possibleAutoplay.autoplay
            ? possibleAutoplay
            : {};

        loadState(core, state);
        await executeFrame(core, autoplay, recording, 4);
        await executeFrame(core, {}, recording, 20);
    }

    await executeFrame(core, {}, recording, 30);

    // push last frame
    const { lastFrame } = recording;
    const file = path.join(recording.tmpDir, `frame-${recording.executedFrameCount}.png`);
    recording.frames.push(sharp(rgb565toRaw(lastFrame), {
        raw: {
            width: lastFrame.width,
            height: lastFrame.height,
            channels: 3
        }
    }).resize({
        width: recording.width,
        height: recording.height,
        kernel: sharp.kernel.nearest
    }).png({
        quality: recording.quality
    }).toFile(file).then(() => ({
        file,
        frameNumber: recording.executedFrameCount
    })))

    const frames = await Promise.all(recording.frames);

    shelljs.mkdir('-p', 'output');

    let framesTxt = '';
    for (let i = 0; i < frames.length; i++) {
        const current = frames[i];

        framesTxt += `file '${current.file}'\n`;

        const next = frames[i + 1];
        if (next) {
            framesTxt += `duration ${(next.frameNumber - current.frameNumber) / 60}\n`;
        }
    }

    framesTxt += `duration ${1 / 60}\n`;
    framesTxt += `file '${last(frames).file}'\n`;
    framesTxt += `duration 5\n`;
    framesTxt += `file '${last(frames).file}'\n`;

    const { name: framesList } = tmp.fileSync();
    fs.writeFileSync(framesList, framesTxt);

    const { name: outputName } = tmp.fileSync();
    const gifOutput = `${outputName}.gif`;
    const mp4Output = `${outputName}.mp4`;
    let output = gifOutput;

    await new Promise<void>((res, rej) =>
        ffmpeg()
            .input(framesList)
            .addInputOption('-safe', '0')
            .inputFormat('concat')
            .addOption('-filter_complex', `split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse`)
            .output(gifOutput)
            .on('error', (err, stdout, stderr) => {
                console.log(stdout)
                console.error(stderr);
                rej(err)
            })
            .on('end', res)
            .run());

    if (fs.statSync(gifOutput).size > 8 * 1024 * 1024) {
        output = mp4Output

        await new Promise<void>((res, rej) =>
            ffmpeg()
                .input(gifOutput)
                .output(mp4Output)
                .on('error', (err, stdout, stderr) => {
                    console.log(stdout)
                    console.error(stderr);
                    rej(err)
                })
                .on('end', res)
                .run());
    }

    const recordingBuffer = fs.readFileSync(output);

    shelljs.rm('-rf', framesList);
    shelljs.rm('-rf', recording.tmpDir);
    shelljs.rm('-rf', gifOutput);
    shelljs.rm('-rf', mp4Output);

    return {
        state: saveState(core),
        recording: recordingBuffer,
        recordingName: path.basename(output),
        core
    }
}

const isDirection = (input?: InputState) => {
    if (input?.UP) return true;
    if (input?.DOWN) return true;
    if (input?.LEFT) return true;
    if (input?.RIGHT) return true;
    return false;
}