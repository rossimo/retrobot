import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { request } from 'undici';
import { v4 as uuid } from 'uuid';
import * as shelljs from 'shelljs';
import * as LruCache from 'lru-cache';
import { toLower, endsWith, range } from 'lodash';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, CacheType, Client, GatewayIntentBits, Interaction, Message } from 'discord.js';

import { InputState } from './util';
import { CoreType, emulate } from './emulate';

const NES = ['nes'];
const SNES = ['sfc', 'smc'];
const GB = ['gb', 'gbc', 'gba'];

const ALL = [...NES, ...SNES, ...GB];

const main = async () => {
    const coreCache = new LruCache({ max: 100 });
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    await client.login(process.env.DISCORD_TOKEN);
    console.log('online');

    client.on('messageCreate', async (message: Message) => {
        const attachment = message.attachments.find(att => !!ALL.find(ext => endsWith(att.name, ext)));
        if (!attachment) {
            return;
        }

        let coreType: CoreType;
        if (NES.find(ext => endsWith(attachment.name, ext))) {
            coreType = CoreType.NES;
        } else if (SNES.find(ext => endsWith(attachment.name, ext))) {
            coreType = CoreType.SNES;
        } else if (GB.find(ext => endsWith(attachment.name, ext))) {
            coreType = CoreType.GB;
        } else {
            return;
        }

        const { body } = await request(attachment.url);
        const buffer = Buffer.from(await body.arrayBuffer());

        const id = uuid().slice(0, 5);

        const data = path.resolve('data', id);
        shelljs.mkdir('-p', data);

        const gameFile = path.join(data, attachment.name);
        fs.writeFileSync(gameFile, buffer);

        const info = {
            game: attachment.name,
            coreType,
            guild: message.guildId,
            channelId: message.channelId
        };

        const infoFile = path.join(data, 'info.json');
        fs.writeFileSync(infoFile, JSON.stringify(info, null, 4));

        const { recording, recordingName, state } = await emulate(coreType, buffer, null, []);

        const stateFile = path.join(data, 'state.sav');
        fs.writeFileSync(stateFile, state);

        await message.channel.send({
            files: [{
                attachment: recording,
                name: recordingName
            }],
            components: buttons(id, 1, true),
        });
    });

    client.on('interactionCreate', async (interaction: Interaction<CacheType>) => {
        if (interaction.isButton()) {
            const player = client.guilds.cache.get(interaction.guildId).members.cache.get(interaction.user.id);
            const message = interaction.message;

            let update = new Promise(res => res({}));

            const [id, button, multiplier] = interaction.customId.split('-');

            let playerInputs: InputState[] = [];

            if (isNumeric(button)) {
                update = update.then(() => message.edit({ components: buttons(id, parseInt(button), true) }));
            } else {
                update = update.then(() => message.edit({ components: buttons(id, parseInt(multiplier), false, button) }));
                playerInputs = range(0, parseInt(multiplier)).map(() => parseInput(button));
            }

            update = update.then(() => interaction.update({}));

            update.catch(err => console.warn(err));

            if (playerInputs.length > 0 && fs.existsSync(path.resolve('data', id))) {
                const info = JSON.parse(fs.readFileSync(path.resolve('data', id, 'info.json')).toString());
                let core = coreCache.get(id);
                coreCache.delete(id);

                let game;
                let oldState;
                if (!core) {
                    game = fs.readFileSync(path.resolve('data', id, info.game))
                    oldState = fs.readFileSync(path.resolve('data', id, 'state.sav'));
                }

                const { recording, recordingName, state: newState, core: newCore } = await emulate(info.coreType, game, oldState, playerInputs, core);
                coreCache.set(id, newCore);

                fs.writeFileSync(path.resolve('data', id, 'state.sav'), newState);

                message.channel.send({
                    files: [{
                        attachment: recording,
                        name: recordingName
                    }],
                    components: buttons(id, 1, true)
                }).catch(err => console.warn(err));
            }
        }
    });
}

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
};

const isNumeric = (value) => {
    return /^\d+$/.test(value);
};

const buttons = (id: string, multiplier: number = 1, enabled: boolean = true, highlight?: string) => {
    const a = new ButtonBuilder()
        .setCustomId(id + '-' + 'a' + '-' + multiplier)
        .setEmoji('🇦')
        .setDisabled(!enabled)
        .setStyle(highlight == 'a' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const b = new ButtonBuilder()
        .setCustomId(id + '-' + 'b' + '-' + multiplier)
        .setEmoji('🇧')
        .setDisabled(!enabled)
        .setStyle(highlight == 'b' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const up = new ButtonBuilder()
        .setCustomId(id + '-' + 'up' + '-' + multiplier)
        .setEmoji('⬆️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'up' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const down = new ButtonBuilder()
        .setCustomId(id + '-' + 'down' + '-' + multiplier)
        .setEmoji('⬇️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'down' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const left = new ButtonBuilder()
        .setCustomId(id + '-' + 'left' + '-' + multiplier)
        .setEmoji('⬅️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'left' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const right = new ButtonBuilder()
        .setCustomId(id + '-' + 'right' + '-' + multiplier)
        .setEmoji('➡️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'right' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const select = new ButtonBuilder()
        .setCustomId(id + '-' + 'select' + '-' + multiplier)
        .setEmoji('⏺️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'select' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const start = new ButtonBuilder()
        .setCustomId(id + '-' + 'start' + '-' + multiplier)
        .setEmoji('▶️')
        .setDisabled(!enabled)
        .setStyle(highlight == 'start' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const multiply5 = new ButtonBuilder()
        .setCustomId(id + '-' + '5' + '-' + multiplier)
        .setEmoji('5️⃣')
        .setDisabled(!enabled)
        .setStyle(highlight == '5' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const multiply10 = new ButtonBuilder()
        .setCustomId(id + '-' + '10' + '-' + multiplier)
        .setEmoji('🔟')
        .setDisabled(!enabled)
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