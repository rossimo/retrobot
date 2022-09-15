import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import Piscina from 'piscina';
import { crc32 } from 'hash-wasm';
import * as shelljs from 'shelljs';
import ffmpeg from 'fluent-ffmpeg';
import { performance } from 'perf_hooks';
import { values, first, size, last, isEqual } from 'lodash';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

import { arraysEqual, InputState, isDirection, rgb565toRaw } from './util';
import sharp = require('sharp');
import { emulateParallel } from './workerInterface';
import { Frame } from './worker';

tmp.setGracefulCleanup();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 30;

interface AutoplayInputState extends InputState {
    autoplay?: boolean
    data?: any
}

const TEST_INPUTS: AutoplayInputState[] = [
    { A: true, autoplay: true },
    { B: true, autoplay: false },
    { DOWN: true, autoplay: false },
    { UP: true, autoplay: false },
    { LEFT: true, autoplay: false },
    { RIGHT: true, autoplay: false }
];

export enum CoreType {
    NES = 'nes',
    SNES = 'snes',
    GB = 'gb',
    GBA = 'gba'
}

export const emulate = async (pool: Piscina, coreType: CoreType, game: Uint8Array, state: Uint8Array, playerInputs: InputState[]) => {
    let data = { coreType, game, state, frames: [], av_info: {} as any };

    const startEmulation = performance.now();

    for (let i = 0; i < playerInputs.length; i++) {
        const prev = playerInputs[i - 1];
        const current = playerInputs[i];
        const next = playerInputs[i + 1];

        if (isDirection(current)) {
            if (isEqual(current, next) || isEqual(current, prev)) {
                data = await emulateParallel(pool, data, { input: current, duration: 20 });
            } else {
                data = await emulateParallel(pool, data, { input: current, duration: 8 });
                data = await emulateParallel(pool, data, { input: {}, duration: 8 });
            }
        } else {
            data = await emulateParallel(pool, data, { input: current, duration: 4 });
            data = await emulateParallel(pool, data, { input: {}, duration: 16 });
        }
    }

    const endFrameCount = data.frames.length + 30 * 60;

    test: while (data.frames.length < endFrameCount) {
        data = await emulateParallel(pool, data, { input: {}, duration: 32 });

        const state = new Uint8Array(data.state);

        const possibilities: { [hash: string]: AutoplayInputState } = {};
        const controlResultTask = emulateParallel(pool, data, { input: {}, duration: 20 })

        const controlResultHash = controlResultTask.then(result => crc32(last(result.frames).buffer));

        await Promise.all(TEST_INPUTS.map(testInput => async () => {
            if (size(possibilities) > 1) {
                return;
            }

            let testData = { ...data, state };
            testData = await emulateParallel(pool, testData, { input: testInput, duration: 4 });
            if (size(possibilities) > 1) {
                return;
            }

            const testResult = await emulateParallel(pool, testData, { input: {}, duration: 16 });
            if (size(possibilities) > 1) {
                return;
            }

            const testResultHash = await crc32(last(testResult.frames).buffer);
            if (size(possibilities) > 1) {
                return;
            }

            if ((await controlResultHash) != testResultHash) {
                if (!possibilities[testResultHash] || (possibilities[testResultHash] && testInput.autoplay)) {
                    possibilities[testResultHash] = {
                        ...testInput,
                        data: testResult
                    };
                }
            }
        }).map(task => task()));

        if (size(possibilities) > 1) {
            break test;
        }

        const possibleAutoplay = first(values(possibilities));

        if (size(possibilities) == 1 && possibleAutoplay.autoplay) {
            data = possibleAutoplay.data;
        } else {
            data = await controlResultTask;
        }
    }

    data = await emulateParallel(pool, data, { input: {}, duration: 30 });

    const endEmulation = performance.now();
    console.log(`Emulation: ${endEmulation - startEmulation}`);

    const startFrames = performance.now();

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
        }).toFile(file).then(() => ({
            file,
            frameNumber: frame.renderTime
        }))
    }))

    const endFrames = performance.now();
    console.log(`Exporting frames: ${endFrames - startFrames}`);

    const startEncode = performance.now();

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
            .addOption('-filter_complex', `split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse=dither=bayer:bayer_scale=5`)
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

    const endEncode = performance.now();
    console.log(`Encoding: ${endEncode - startEncode}`);

    return {
        state: data.state,
        recording: recordingBuffer,
        recordingName: path.basename(output)
    }
}