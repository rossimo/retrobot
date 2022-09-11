import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import Piscina from 'piscina';
import { crc32 } from 'hash-wasm';
import * as shelljs from 'shelljs';
import ffmpeg from 'fluent-ffmpeg';
import { values, first, size, last, isEqual } from 'lodash';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

import { arraysEqual, executeFrame, InputState, isDirection, loadRom as loadGame, loadState, Recording, rgb565toRaw, saveState } from './util';
import sharp = require('sharp');
import { emulateParallel } from './workerInterface';
import { Frame } from './worker';

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

export const emulate = async (pool: Piscina, coreType: CoreType, game: Uint8Array, state: Uint8Array, playerInputs: InputState[]) => {
    let data = { coreType, game, state, frames: [], av_info: {} as any };

    for (let i = 0; i < playerInputs.length; i++) {
        const prev = playerInputs[i - 1];
        const current = playerInputs[i];
        const next = playerInputs[i + 1];

        if (isDirection(current)) {
            if (isEqual(current, next) || isEqual(current, prev)) {
                data = await emulateParallel(pool, data, { input: current, duration: 20 });
            } else {
                data = await emulateParallel(pool, data, { input: current, duration: 4 });
                data = await emulateParallel(pool, data, { input: {}, duration: 16 });
            }
        } else {
            data = await emulateParallel(pool, data, { input: current, duration: 4 });
            data = await emulateParallel(pool, data, { input: {}, duration: 16 });
        }
    }

    /*
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
*/
    data = await emulateParallel(pool, data, { input: {}, duration: 30 });

    const { frames } = data;
    const importantFrames: (Frame & { renderTime: number })[] = [];
    let lastFrame: Frame;
    let durationSinceFrame = 0;
    for (let i = 0; i < frames.length; i++) {
        if (i == 0 || durationSinceFrame >= (60 / RECORDING_FRAMERATE)) {
            const currentFrame = frames[i];

            if (!arraysEqual(currentFrame.buffer, lastFrame?.buffer)) {
                importantFrames.push({
                    ...currentFrame,
                    renderTime: i
                })

                lastFrame = currentFrame;
                durationSinceFrame = 0;
            }
        } else {
            durationSinceFrame++;
        }
    }

    if (!arraysEqual(last(importantFrames).buffer, lastFrame.buffer)) {
        importantFrames.push({
            ...last(importantFrames),
            renderTime: frames.length
        })
    }

    const tmpFrameDir = tmp.dirSync({ unsafeCleanup: true });

    const pngs = await Promise.all(importantFrames.map((frame) => {
        const file = path.join(tmpFrameDir.name, `frame-${frame.renderTime}.png`);

        return sharp(rgb565toRaw(frame), {
            raw: {
                width: frame.width,
                height: frame.height,
                channels: 3
            }
        }).resize({
            width: data.av_info.geometry_base_width * 2,
            height: data.av_info.geometry_base_height * 2,
            kernel: sharp.kernel.nearest
        }).png({
            quality: 100
        }).toFile(file).then(() => ({
            file,
            frameNumber: frame.renderTime
        }))
    }))


    shelljs.mkdir('-p', 'output');

    let framesTxt = '';
    for (let i = 0; i < pngs.length; i++) {
        const current = pngs[i];

        framesTxt += `file '${current.file}'\n`;

        const next = pngs[i + 1];
        if (next) {
            framesTxt += `duration ${(next.frameNumber - current.frameNumber) / 60}\n`;
        }
    }

    framesTxt += `duration ${1 / 60}\n`;
    framesTxt += `file '${last(pngs).file}'\n`;
    framesTxt += `duration 5\n`;
    framesTxt += `file '${last(pngs).file}'\n`;

    const tmpFramesList = tmp.fileSync({ discardDescriptor: true });
    fs.writeFileSync(tmpFramesList.name, framesTxt);

    const { name: outputName } = tmp.fileSync();
    const gifOutput = `${outputName}.gif`;
    const mp4Output = `${outputName}.mp4`;
    let output = gifOutput;

    await new Promise<void>((res, rej) =>
        ffmpeg()
            .input(tmpFramesList.name)
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

    shelljs.rm('-rf', gifOutput);
    shelljs.rm('-rf', mp4Output);

    tmpFrameDir.removeCallback();
    tmpFramesList.removeCallback();

    return {
        state: data.state,
        recording: recordingBuffer,
        recordingName: path.basename(output)
    }
}