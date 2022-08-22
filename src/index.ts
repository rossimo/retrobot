import * as fs from 'fs';
import * as sharp from 'sharp';
import * as tmp from 'tmp';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

const Gambatte = require('../cores/snes9x2010_libretro');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 60;

const main = async () => {
    const core = await Gambatte();

    core.retro_set_environment((cmd: number, data: any) => {
        if (cmd == 27) {
            return false;
        }

        if (cmd == 3) {
            core.HEAPU8[data] = 1;
        }

        return true;
    });

    const buffer = fs.readFileSync('ffiii.sfc').buffer;
    const romData = core.asm.malloc(buffer.byteLength);
    var romHeap = new Uint8Array(core.HEAPU8.buffer, romData, buffer.byteLength);
    romHeap.set(new Uint8Array(buffer));

    if (!core.retro_load_game({ data: romData, size: buffer.byteLength })) {
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

    let frameCount = 1;
    for (let i = 0; i < 60 * 30; i++) {
        const frame = await new Promise<Uint8Array>((res) => {
            core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
                const frame = new Uint16Array(core.HEAPU16.subarray(data / 2, (data + pitch * height) / 2));

                const raw = new Uint8Array(width * height * 3);

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const actualPixel = frame[(pitch * y) / 2 + x];

                        const r = (actualPixel >> 8) & 0xF8;
                        const g = (actualPixel >> 3) & 0xFC;
                        const b = (actualPixel) << 3;

                        const i = (x + width * y) * 3;
                        raw[i] = r;
                        raw[i + 1] = g;
                        raw[i + 2] = b;
                    }
                }

                res(raw);
            });

            core.retro_run();
        });

        if (i % (60 / RECORDING_FRAMERATE) == 0) {
            frameTasks.push(sharp(frame, { raw: { width: av_info.geometry_base_width, height: av_info.geometry_base_height, channels: 3 } })
                .toFile(`frames/frame-${frameCount++}.png`));
        }
    }

    await Promise.all(frameTasks);

    shelljs.mkdir('-p', 'output');

    const { name: tmpDir } = tmp.dirSync();

    let framesTxt = '';
    for (let i = 1; i < frameCount; i++) {
        framesTxt += `file 'frames/frame-${i}.png'\n`;
        framesTxt += `duration ${(60 / RECORDING_FRAMERATE) / 60}\n`;
    }

    framesTxt += `file 'frames/frame-${frameCount - 1}.png'\n`;

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