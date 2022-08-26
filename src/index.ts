import * as fs from 'fs';
import * as tmp from 'tmp';
import * as sharp from 'sharp';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';


import { last } from 'lodash';
import { executeFrame, InputState, loadRom as loadGame, loadState, Recording, rgb565toRaw, saveState } from './util';
import { arraysEqual } from './utils';

tmp.setGracefulCleanup();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 20;

const INPUTS: InputState[] = [
    { A: true },
    { B: true },
];

const main = async () => {
    const Core = require('../cores/gambatte_libretro');

    let core = await Core();

    const env = (core) => (cmd: number, data: any) => {
        if (cmd == 27) {
            return false;
        }

        if (cmd == 3) {
            core.HEAPU8[data] = 1;
        }

        return true;
    }

    core.retro_set_environment(env(core));

    const game = fs.readFileSync('pokemon.gb').buffer;
    loadGame(core, game);

    const system_info = {};
    const av_info: any = {};

    core.retro_get_system_info(system_info);
    core.retro_get_system_av_info(av_info);

    console.log({ system_info, av_info });

    if (fs.existsSync('state.sav')) {
        loadState(core, fs.readFileSync('state.sav').buffer);
    }

    const start = performance.now();

    const recording: Recording = {
        tmpDir: tmp.dirSync().name,
        maxFramerate: av_info.timing_fps / RECORDING_FRAMERATE,
        executedFrameCount: -1,
        frames: [],
        lastBuffer: new Uint16Array(),
        lastRecordedBuffer: new Uint16Array(),
        framesSinceRecord: -1,
        width: av_info.geometry_base_width * 2,
        height: av_info.geometry_base_height * 2,
        quality: 100
    };

    for (let j = 0; j < 1; j++) {
        await executeFrame(core, { A: true }, recording, 8);

        await executeFrame(core, {}, recording, 8);
    }

    await executeFrame(core, {}, recording, 60 * 30);
    
    /*
    let state: Uint8Array;

    test: for (let i = 0; i < 30; i++) {
        await executeFrame(core, {}, recording, 52);

        state = saveState(core);

        const controlResult = await executeFrame(core, {}, null, 8);

        for (const input of INPUTS) {
            loadState(core, state);

            const testResult = await executeFrame(core, input, null, 8);

            if (!arraysEqual(controlResult.buffer, testResult.buffer)) {
                await sharp(rgb565toRaw(controlResult), {
                    raw: {
                        width: controlResult.width,
                        height: controlResult.height,
                        channels: 3
                    }
                }).toFile('control.png');

                await sharp(rgb565toRaw(testResult), {
                    raw: {
                        width: testResult.width,
                        height: testResult.height,
                        channels: 3
                    }
                }).toFile('test.png');
                break test;
            }
        }
    }
    */

    const frames = await Promise.all(recording.frames);

    fs.writeFileSync('state.sav', saveState(core));

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

    fs.writeFileSync('frames.txt', framesTxt);

    await new Promise<void>((res, rej) =>
        ffmpeg()
            .input('frames.txt')
            .addInputOption('-safe', '0')
            .inputFormat('concat')
            .addOption('-filter_complex', `split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse`)
            .output('outputfile.gif')
            .on('error', (err, stdout, stderr) => {
                console.log(stdout)
                console.error(stderr);
                rej(err)
            })
            .on('end', res)
            .run());

    const end = performance.now();

    console.log(end - start);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
})