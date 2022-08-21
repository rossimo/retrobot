import * as fs from 'fs';
import * as sharp from 'sharp';
import * as path from 'path';
import * as tmp from 'tmp';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';

const Gambatte = require('../cores/gambatte_libretro');

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

    const system_info = {};
    core.retro_get_system_info(system_info);
    console.log(system_info);

    const buffer = fs.readFileSync('pokemon.gb').buffer;
    const romData = core.asm.malloc(buffer.byteLength);
    var romHeap = new Uint8Array(core.HEAPU8.buffer, romData, buffer.byteLength);
    romHeap.set(new Uint8Array(buffer));

    if (!core.retro_load_game({ data: romData, size: buffer.byteLength })) {
        throw new Error('Failed to load');
    }

    const start = performance.now();

    shelljs.rm('-rf', 'frames');
    shelljs.mkdir('-p', 'frames');

    const frameTasks: Promise<sharp.OutputInfo>[] = [];

    let frameCount = 1;
    for (let i = 0; i < 60 * 30; i++) {
        const frame = await new Promise<Uint8Array>((res) => {
            core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
                width = 256 * 2;

                res(new Uint8Array(core.HEAPU8.subarray(data, data + width * height)));
            });

            core.retro_run();
        });

        if (i % (60 / RECORDING_FRAMERATE) == 0) {
            frameTasks.push(sharp(frame, { raw: { width: 256 * 2, height: 144, channels: 1 } })
                .extract({ width: 320, height: 144, top: 0, left: 0 })
                .resize({ width: 160, height: 144, fit: sharp.fit.fill, kernel: sharp.kernel.nearest })
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
            .addOption('-filter_complex', `scale=320:-1:flags=neighbor,split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse`)
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