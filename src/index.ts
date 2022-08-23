import * as fs from 'fs';
import * as sharp from 'sharp';
import * as tmp from 'tmp';
import * as path from 'path';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import { last } from 'lodash';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { arraysEqual } from './utils';

const Core = require('../cores/gambatte_libretro');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 15;

const main = async () => {
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

    const romBuffer = fs.readFileSync('pokemon.gb').buffer;
    const romData = core.asm.malloc(romBuffer.byteLength);
    const romHeap = new Uint8Array(core.HEAPU8.buffer, romData, romBuffer.byteLength);
    romHeap.set(new Uint8Array(romBuffer));

    if (!core.retro_load_game({ data: romData, size: romBuffer.byteLength })) {
        throw new Error('Failed to load');
    }

    const system_info = {};
    core.retro_get_system_info(system_info);
    console.log(system_info);

    const av_info: any = {};
    core.retro_get_system_av_info(av_info);
    console.log(av_info);

    const start = performance.now();

    shelljs.rm('-rf', 'frames');
    shelljs.mkdir('-p', 'frames');

    const frameTasks: Promise<sharp.OutputInfo>[] = [];
    const frames: {
        file: string
        frameNumber: number
    }[] = [];

    let lastBuffer: Uint16Array;
    let lastRecordedBuffer = new Uint16Array();

    let framesSinceRecord = -1;

    for (let i = 0; i < av_info.timing_fps * 30; i++) {
        const frame = await new Promise<{ buffer: Uint16Array, width: number, height: number, pitch: number }>((res) => {
            core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
                lastBuffer = data
                    ? new Uint16Array(core.HEAPU16.subarray(data / 2, (data + pitch * height) / 2))
                    : lastBuffer;

                res({
                    buffer: lastBuffer,
                    width,
                    height,
                    pitch
                })
            });

            core.retro_run();
        });

        const { buffer, width, height, pitch } = frame;

        framesSinceRecord++;

        if (framesSinceRecord < (av_info.timing_fps / RECORDING_FRAMERATE) || arraysEqual(buffer, lastRecordedBuffer)) {
            continue;
        }

        framesSinceRecord = 0;

        const raw = new Uint8Array(width * height * 3);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = buffer[(pitch * y) / 2 + x];

                const r = (pixel >> 8) & 0xF8;
                const g = (pixel >> 3) & 0xFC;
                const b = (pixel) << 3;

                const i = (x + width * y) * 3;
                raw[i] = r;
                raw[i + 1] = g;
                raw[i + 2] = b;
            }
        }

        const file = path.resolve(`frames/frame-${i}.png`);

        frameTasks.push(sharp(raw, {
            raw: {
                width,
                height,
                channels: 3
            }
        }).png({
            quality: 100
        }).resize({
            width: av_info.geometry_base_width * 2,
            height: av_info.geometry_base_height * 2,
            kernel: sharp.kernel.nearest
        }).toFile(file));

        frames.push({
            file,
            frameNumber: i
        });

        lastRecordedBuffer = buffer;
    }

    await Promise.all(frameTasks);

    shelljs.mkdir('-p', 'output');

    const { name: tmpDir } = tmp.dirSync();

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

    shelljs.rm('-rf', tmpDir);

    const end = performance.now();

    console.log(end - start);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
})