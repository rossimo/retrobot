import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import { md5 } from 'hash-wasm';
import { values, first, size, last, toLower, range, isEqual } from 'lodash';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import * as ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, CacheType, Client, GatewayIntentBits, Interaction, TextChannel, Message, ButtonInteraction, GuildMember } from 'discord.js';

import { executeFrame, InputState, loadRom as loadGame, loadState, Recording, saveState } from './util';
import path = require('path');

tmp.setGracefulCleanup();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const RECORDING_FRAMERATE = 20;

const INPUTS: InputState[] = [
    { A: true },
    { B: true },
    // { START: true },
    // { SELECT: true },
    { UP: true },
    { DOWN: true },
    { LEFT: true },
    { RIGHT: true }
];

const parseInput = (input: string) => {
    switch (toLower(input)) {
        case 'a':
            return { A: true };
        case 'b':
            return { B: true };
        case 'up':
            return { UP: true };
        case 'down':
            return { DOWN: true };
        case 'left':
            return { LEFT: true };
        case 'right':
            return { RIGHT: true };
        case 'select':
            return { SELECT: true };
        case 'start':
            return { START: true };
    }
}

const main = async () => {
    const args = process.argv.slice(2);

    let playerInputs = args.map(arg => parseInput(arg));;
    let player: GuildMember;

    const Core = require('../cores/mgba_libretro');

    const core = await Core();

    const env = (core) => (cmd: number, data: any) => {
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

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    await client.login(process.env.DISCORD_TOKEN);
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID) as TextChannel;
    console.log('online');

    while (true) {
        const emulationStart = performance.now();

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

        const button = last(playerInputs);
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

        test: for (let i = 0; i < 30 / 1.5; i++) {
            await executeFrame(core, {}, recording, 70);

            const state = saveState(core);

            const possibilities: { [hash: string]: InputState } = {};

            await executeFrame(core, {}, null, 4);
            const controlResult = await md5((await executeFrame(core, {}, null, 16)).buffer);

            for (const testInput of INPUTS) {
                loadState(core, state);

                await executeFrame(core, testInput, null, 4)
                const testResult = await md5((await executeFrame(core, {}, null, 16)).buffer);

                if (controlResult != testResult) {
                    possibilities[testResult] = testInput;
                }

                if (size(possibilities) > 1) {
                    loadState(core, state);
                    break test;
                }
            }

            const autoplay = size(possibilities) == 1
                ? first(values(possibilities))
                : {};

            loadState(core, state);
            await executeFrame(core, autoplay, recording, 4);
            await executeFrame(core, {}, recording, 16);
        }

        await executeFrame(core, {}, recording, 20);

        const encodingStart = performance.now();

        console.log(`Encode: ${encodingStart - emulationStart}`);

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

        framesTxt += `duration 5\n`;
        framesTxt += `file '${last(frames).file}'\n`;

        const { name: framesList } = tmp.fileSync();
        fs.writeFileSync(framesList, framesTxt);

        let output = 'output.gif';

        await new Promise<void>((res, rej) =>
            ffmpeg()
                .input(framesList)
                .addInputOption('-safe', '0')
                .inputFormat('concat')
                .addOption('-filter_complex', `split=2 [a][b]; [a] palettegen=reserve_transparent=off [pal]; [b] fifo [b]; [b] [pal] paletteuse`)
                .output('output.gif')
                .on('error', (err, stdout, stderr) => {
                    console.log(stdout)
                    console.error(stderr);
                    rej(err)
                })
                .on('end', res)
                .run());

        if (fs.statSync('output.gif').size > 8 * 1024 * 1024) {
            output = 'output.mp4';

            await new Promise<void>((res, rej) =>
                ffmpeg()
                    .input('output.gif')
                    .output('output.mp4')
                    .on('error', (err, stdout, stderr) => {
                        console.log(stdout)
                        console.error(stderr);
                        rej(err)
                    })
                    .on('end', res)
                    .run());
        }

        shelljs.rm('-rf', framesList);
        shelljs.rm('-rf', recording.tmpDir);

        const encodingEnd = performance.now();

        console.log(`Encode: ${encodingEnd - encodingStart}`);

        console.log(`Sending...`);

        const message = await channel.send({
            content: player && button ? `${player.nickname || player.displayName} pressed ${joyToWord(button)}...` : undefined,
            files: [{
                attachment: path.resolve(output),
            }],
            components: buttons(false),
        });

        console.log(`Waiting...`);
        let multiplier = 1;
        while (true) {
            const interaction = await new Promise<Interaction<CacheType>>((res, rej) => {
                client.once('interactionCreate', res);
            });

            if (interaction.isButton()) {
                player = client.guilds.cache.get(process.env.DISCORD_GUILD_ID).members.cache.get(interaction.user.id);

                let update = new Promise(res => res({}));

                if (isNumeric(interaction.customId)) {
                    // nothing
                } else {
                    update = update.then(() => message.edit({ components: buttons(true, interaction.customId) }));
                }

                update = update.then(() => interaction.update({}));

                update.catch(err => console.warn(err));

                if (isNumeric(interaction.customId)) {
                    multiplier = parseInt(interaction.customId);
                } else {
                    playerInputs = range(0, multiplier).map(() => parseInput(interaction.customId));
                    break;
                }
            }
        }
    }
}

const isNumeric = (value) => {
    return /^\d+$/.test(value);
};

const buttons = (disabled: boolean = false, highlight?: string) => {
    const a = new ButtonBuilder()
        .setCustomId('a')
        .setEmoji('🇦')
        .setDisabled(disabled)
        .setStyle(highlight == 'a' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const b = new ButtonBuilder()
        .setCustomId('b')
        .setEmoji('🇧')
        .setDisabled(disabled)
        .setStyle(highlight == 'b' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const up = new ButtonBuilder()
        .setCustomId('up')
        .setEmoji('⬆️')
        .setDisabled(disabled)
        .setStyle(highlight == 'up' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const down = new ButtonBuilder()
        .setCustomId('down')
        .setEmoji('⬇️')
        .setDisabled(disabled)
        .setStyle(highlight == 'down' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const left = new ButtonBuilder()
        .setCustomId('left')
        .setEmoji('⬅️')
        .setDisabled(disabled)
        .setStyle(highlight == 'left' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const right = new ButtonBuilder()
        .setCustomId('Right')
        .setEmoji('➡️')
        .setDisabled(disabled)
        .setStyle(highlight == 'right' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const select = new ButtonBuilder()
        .setCustomId('select')
        .setEmoji('⏺️')
        .setDisabled(disabled)
        .setStyle(highlight == 'select' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const start = new ButtonBuilder()
        .setCustomId('start')
        .setEmoji('▶️')
        .setDisabled(disabled)
        .setStyle(highlight == 'start' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const multiply5 = new ButtonBuilder()
        .setCustomId('5')
        .setEmoji('5️⃣')
        .setDisabled(disabled)
        .setStyle(highlight == '5' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const multiply10 = new ButtonBuilder()
        .setCustomId('10')
        .setEmoji('🔟')
        .setDisabled(disabled)
        .setStyle(highlight == '10' ? ButtonStyle.Success : ButtonStyle.Secondary);

    return [
        new ActionRowBuilder()
            .addComponents(
                a, b
            ),
        new ActionRowBuilder()
            .addComponents(
                up, down, left, right
            ),
        new ActionRowBuilder()
            .addComponents(
                select, start, multiply5, multiply10
            )
    ] as any[];
};

const isDirection = (input?: InputState) => {
    if (input?.UP) return true;
    if (input?.DOWN) return true;
    if (input?.LEFT) return true;
    if (input?.RIGHT) return true;
    return false;
}


const joyToWord = (input: InputState) => {
    if (input.A) return 'A';
    if (input.B) return 'B';
    if (input.UP) return 'Up';
    if (input.DOWN) return 'Down';
    if (input.LEFT) return 'Left';
    if (input.RIGHT) return 'Right';
    if (input.START) return 'Start';
    if (input.SELECT) return 'Select';
}

main().catch(err => {
    console.error(err);
    process.exit(1);
})