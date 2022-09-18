import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import Piscina from 'piscina';
import encode from 'image-encode';
import { crc32 } from 'hash-wasm';
import * as shelljs from 'shelljs';
import ffmpeg from 'fluent-ffmpeg';
import { performance } from 'perf_hooks';
import { values, first, size, last, isEqual } from 'lodash';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

import { arraysEqual, InputState, isDirection, rgb565toRaw } from './util';
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
        const possibilities: { [hash: string]: AutoplayInputState } = {};

        const controlResultTask = emulateParallel(pool, data, { input: {}, duration: 20 })
        const controlHashTask = controlResultTask.then(result => crc32(last(result.frames).buffer));

        await Promise.all(TEST_INPUTS.map(testInput => async () => {
            if (size(possibilities) > 1) {
                return;
            }

            const testInputData = await emulateParallel(pool, data, { input: testInput, duration: 4 });
            const testIdleData = await emulateParallel(pool, testInputData, { input: {}, duration: 16 });

            const testHash = await crc32(last(testIdleData.frames).buffer);

            if ((await controlHashTask) != testHash) {
                if (!possibilities[testHash] || (possibilities[testHash] && testInput.autoplay)) {
                    possibilities[testHash] = {
                        ...testInput,
                        data: testIdleData
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

        data = await emulateParallel(pool, data, { input: {}, duration: 32 });
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

    const { width, height } = last(importantFrames);

    const images = await Promise.all(importantFrames.map((frame) => {
        const file = path.join(tmpFrameDir.name, `frame-${frame.renderTime}.bmp`);

        return new Promise<{ file: string, frameNumber: number }>((res, rej) =>
            fs.writeFile(file, Buffer.from(encode(rgb565toRaw(frame), [width, height],'bmp')), (err) => {
                if (err) {
                    rej(err)
                } else {
                    res({
                        file,
                        frameNumber: frame.renderTime
                    });
                }
            }));
    }))

    const endFrames = performance.now();
    console.log(`Exporting frames: ${endFrames - startFrames}`);

    const startEncode = performance.now();

    let framesTxt = '';
    for (let i = 0; i < images.length; i++) {
        const current = images[i];

        framesTxt += `file '${current.file}'\n`;

        const next = images[i + 1];
        if (next) {
            framesTxt += `duration ${(next.frameNumber - current.frameNumber) / 60}\n`;
        }
    }

    framesTxt += `duration ${1 / 60}\n`;
    framesTxt += `file '${last(images).file}'\n`;
    framesTxt += `duration 5\n`;
    framesTxt += `file '${last(images).file}'\n`;

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
            .addOption('-filter_complex', `scale=2*iw:2*ih:flags=neighbor,split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse=dither=bayer:bayer_scale=5`)
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