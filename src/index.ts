import 'dotenv/config';
import * as fs from 'fs';
import Piscina from 'piscina';
import * as path from 'path';
import glob from 'fast-glob';
import { request } from 'undici';
import { v4 as uuid } from 'uuid';
import * as shelljs from 'shelljs';
import LruCache from 'lru-cache';
import { toLower, endsWith, range, uniq, split, first } from 'lodash';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, CacheType, Client, ComponentType, GatewayIntentBits, Interaction, Message, PermissionsBitField, TextChannel } from 'discord.js';

import { InputState } from './util';
import { CoreType, emulate } from './emulate';

const NES = ['nes'];
const SNES = ['sfc', 'smc'];
const GB = ['gb', 'gbc'];
const GBA = ['gba'];

const ALL = [...NES, ...SNES, ...GB, ...GBA];

const pool = new Piscina({
    filename: path.resolve(__dirname, path.resolve(__dirname, 'worker.ts')),
    name: 'default',
    execArgv: ['-r', 'ts-node/register']
});

const main = async () => {
    const coreCache = new LruCache({ max: 150, ttl: 5 * 60 * 1000 });
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    await client.login(process.env.DISCORD_TOKEN);
    console.log('online');

    const infoFiles = await glob('data/*/info.json');
    const infos = infoFiles.map(infoFile => ({
        id: infoFile.split(/[\\\/]/).at(-2),
        ...(JSON.parse(fs.readFileSync(infoFile).toString()))
    }));

    const infoIds = uniq(infos.map(info => info.id));
    const channelIds: string[] = uniq(infos.map(info => info.channelId));

    let messages: Message[] = []

    for (const channelId of channelIds) {
        try {
            const channel = client.channels.cache.get(channelId) as TextChannel;
            const messageCollection = await channel.messages.fetch({ limit: 100 });
            messages = [...messages, ...messageCollection.values()];
        } catch (err) {
            console.log(err);
        }
    }

    messages = messages.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    info: for (const infoId of infoIds) {
        for (const message of messages) {
            if (message.author.id == client.user.id) {
                const button = message.components.find(component => component.type == ComponentType.ActionRow)?.components
                    ?.find(component => component.type == ComponentType.Button);

                const id = first(split(button?.customId, '-'));

                if (id == infoId) {
                    const info = infos.find(info => info.id == id);

                    if (button?.disabled) {
                        const channel = client.channels.cache.get(message.channel.id) as TextChannel;
                        console.log(`unlocking ${info.game} in ${channel.name}`);
                        await message.edit({ components: buttons(info.coreType, id, 1, true) });
                    }

                    continue info;
                }
            }
        }
    }

    client.on('messageCreate', async (message: Message) => {
        const attachment = message.attachments.find(att => !!ALL.find(ext => endsWith(toLower(att.name), ext)));
        if (!attachment || !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return;
        }

        let coreType: CoreType;
        if (NES.find(ext => endsWith(toLower(attachment.name), ext))) {
            coreType = CoreType.NES;
        } else if (SNES.find(ext => endsWith(toLower(attachment.name), ext))) {
            coreType = CoreType.SNES;
        } else if (GB.find(ext => endsWith(toLower(attachment.name), ext))) {
            coreType = CoreType.GB;
        } else if (GBA.find(ext => endsWith(toLower(attachment.name), ext))) {
            coreType = CoreType.GBA;
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

        const { recording, recordingName, state } = await emulate(pool, coreType, buffer, null, []);

        const stateFile = path.join(data, 'state.sav');
        fs.writeFileSync(stateFile, state);

        await message.channel.send({
            files: [{
                attachment: recording,
                name: recordingName
            }],
            components: buttons(coreType, id, 1, true),
        });
    });

    client.on('interactionCreate', async (interaction: Interaction<CacheType>) => {
        if (interaction.isButton()) {
            try {
                const player = client.guilds.cache.get(interaction.guildId).members.cache.get(interaction.user.id);
                const message = interaction.message;

                const [id, button, multiplier] = interaction.customId.split('-');

                if (fs.existsSync(path.resolve('data', id))) {
                    const info = JSON.parse(fs.readFileSync(path.resolve('data', id, 'info.json')).toString());

                    (async () => {
                        try {
                            if (isNumeric(button)) {
                                await message.edit({ components: buttons(info.coreType, id, parseInt(button), true) });
                            } else {
                                await message.edit({ components: buttons(info.coreType, id, parseInt(multiplier), false, button) });
                            }

                            await interaction.update({});
                        } catch (err) {
                            console.error(err);
                        }
                    })()

                    let playerInputs: InputState[] = [];

                    if (isNumeric(button)) {
                    } else {
                        playerInputs = range(0, parseInt(multiplier)).map(() => parseInput(button));
                    }

                    if (playerInputs.length > 0) {

                        message.channel.sendTyping();

                        const info = JSON.parse(fs.readFileSync(path.resolve('data', id, 'info.json')).toString());

                        let game = fs.readFileSync(path.resolve('data', id, info.game))
                        let oldState = fs.readFileSync(path.resolve('data', id, 'state.sav'));

                        const { recording, recordingName, state: newState } = await emulate(pool, info.coreType, game, oldState, playerInputs);

                        fs.writeFileSync(path.resolve('data', id, 'state.sav'), newState);

                        await message.channel.send({
                            content: `${player.nickname || player.displayName} pressed ${joyToWord(first(playerInputs))}${parseInt(multiplier) > 1 ? ' x' + multiplier : ''}...`,
                            files: [{
                                attachment: recording,
                                name: recordingName
                            }],
                            components: buttons(info.coreType, id, 1, true)
                        });
                    }
                } else {
                    await interaction.update({ content: 'Cannot find save for this game' });
                }
            } catch (err) {
                console.error(err);
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
        case 'x':
            return { X: true };
        case 'y':
            return { Y: true };
        case 'l':
            return { L: true };
        case 'r':
            return { R: true };
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

const buttons = (coreType: CoreType, id: string, multiplier: number = 1, enabled: boolean = true, highlight?: string) => {
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

    const x = new ButtonBuilder()
        .setCustomId(id + '-' + 'x' + '-' + multiplier)
        .setEmoji('🇽')
        .setDisabled(!enabled)
        .setStyle(highlight == 'x' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const y = new ButtonBuilder()
        .setCustomId(id + '-' + 'y' + '-' + multiplier)
        .setEmoji('🇾')
        .setDisabled(!enabled)
        .setStyle(highlight == 'y' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const l = new ButtonBuilder()
        .setCustomId(id + '-' + 'l' + '-' + multiplier)
        .setEmoji('🇱')
        .setDisabled(!enabled)
        .setStyle(highlight == 'l' ? ButtonStyle.Success : ButtonStyle.Secondary);

    const r = new ButtonBuilder()
        .setCustomId(id + '-' + 'r' + '-' + multiplier)
        .setEmoji('🇷')
        .setDisabled(!enabled)
        .setStyle(highlight == 'r' ? ButtonStyle.Success : ButtonStyle.Secondary);

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

    const multiply3 = new ButtonBuilder()
        .setCustomId(id + '-' + '3' + '-' + multiplier)
        .setEmoji('3️⃣')
        .setDisabled(!enabled)
        .setStyle(highlight == '3' ? ButtonStyle.Success : ButtonStyle.Secondary);

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

    switch (coreType) {
        case CoreType.GB:
            return [
                new ActionRowBuilder()
                    .addComponents(
                        a, b, select, start,
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        up, down, left, right
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        multiply3, multiply5, multiply10
                    )
            ] as any[];

        case CoreType.GBA:
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
                        select, start, l, r
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        multiply3, multiply5, multiply10
                    )
            ] as any[];

        case CoreType.NES:
            return [
                new ActionRowBuilder()
                    .addComponents(
                        a, b, select, start,
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        up, down, left, right
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        multiply3, multiply5, multiply10
                    )
            ] as any[];

        case CoreType.SNES:
            return [
                new ActionRowBuilder()
                    .addComponents(
                        a, b, x, y
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        up, down, left, right
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        select, start, l, r
                    ),
                new ActionRowBuilder()
                    .addComponents(
                        multiply3, multiply5, multiply10
                    )
            ] as any[];
    }

    return [];
};

const joyToWord = (input: InputState) => {
    if (input.A) return 'A';
    if (input.B) return 'B';
    if (input.X) return 'X';
    if (input.Y) return 'Y';
    if (input.L) return 'L';
    if (input.R) return 'R';
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