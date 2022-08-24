import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import * as sharp from 'sharp';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

import { arraysEqual } from './utils';
import { executeFrame, loadRom as loadGame, loadState, rgb565toRaw, saveState } from './util';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 20;

const main = async () => {
    const Core = require('../cores/snes9x2010_libretro');

    const core = await Core();

    core.retro_set_environment((cmd: number, data: any) => {
        if (cmd == 27) {
            return false;
        }

        if (cmd == 3) {
            core.HEAPU8[data] = 1;
        }

        return true;
    });

    const game = fs.readFileSync('ffiii.sfc').buffer;
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

    shelljs.rm('-rf', 'frames');
    shelljs.mkdir('-p', 'frames');

    const frameTasks: Promise<sharp.OutputInfo>[] = [];
    const frames: { file: string, frameNumber: number }[] = [];

    let lastBuffer: Uint16Array;
    let lastRecordedBuffer = new Uint16Array();
    let framesSinceRecord = -1;

    for (let i = 0; i < av_info.timing_fps * 30; i++) {
        const frame = await executeFrame(core);

        frame.buffer = frame.buffer ? frame.buffer : lastBuffer;
        lastBuffer = frame.buffer;

        const { buffer, width, height } = frame;

        if (framesSinceRecord != -1 && (framesSinceRecord < (av_info.timing_fps / RECORDING_FRAMERATE) || arraysEqual(buffer, lastRecordedBuffer))) {
            framesSinceRecord++;
            continue;
        }

        framesSinceRecord = 0;

        const raw = rgb565toRaw(frame);

        const file = path.resolve(`frames/frame-${i}.png`);

        frameTasks.push(sharp(raw, {
            raw: {
                width,
                height,
                channels: 3
            }
        }).resize({
            width: av_info.geometry_base_width * 2,
            height: av_info.geometry_base_height * 2,
            kernel: sharp.kernel.nearest
        }).png({
            quality: 10
        }).toFile(file));

        frames.push({
            file,
            frameNumber: i
        });

        lastRecordedBuffer = buffer;
    }

    await Promise.all(frameTasks);

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