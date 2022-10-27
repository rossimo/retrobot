import 'dotenv/config';
import * as fs from 'fs';
import Piscina from 'piscina';
import * as path from 'path';
import glob from 'fast-glob';
import { request } from 'undici';
import { v4 as uuid } from 'uuid';
import * as shelljs from 'shelljs';
import decompress from 'decompress';
//import decompressTarxz from 'decompress-tarxz';
import decompressBzip2 from 'decompress-bzip2';
import decompressTargz from 'decompress-targz';
import decompressTarbz2 from 'decompress-tarbz2';
import { toLower, endsWith, range, uniq, split, first, reduce } from 'lodash';
import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, CacheType, Client, SelectMenuBuilder,
    ComponentType, MessageActionRowComponentBuilder, GatewayIntentBits, Interaction, Message,
    PermissionsBitField, TextChannel, MessageOptions, SlashCommandBuilder
} from 'discord.js';

import { InputState } from './util';
import { CoreType, emulate } from './emulate';
import { setGameInfo, isGameId, getGameInfo, GameInfo, InputAssist, InputAssistSpeed, DirectionPress } from './gameInfo';
import { MAX_WORKERS } from './config';

const NES = ['nes'];
const SNES = ['sfc', 'smc'];
const GB = ['gb', 'gbc'];
const GBA = ['gba'];
const COMPRESSED = ['zip', 'tar.gz', 'tar.bz2', 'tar.xz', 'bz2'];

const ALL = [...NES, ...SNES, ...GB, ...GBA, ...COMPRESSED];

const pool = new Piscina({
    filename: path.resolve(__dirname, path.resolve(__dirname, 'worker.ts')),
    name: 'default',
    execArgv: ['-r', 'ts-node/register'],
    ...MAX_WORKERS == -1
        ? {}
        : { maxThreads: MAX_WORKERS }
});

const main = async () => {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    await client.login(process.env.DISCORD_TOKEN);
    console.log('online');

    const command = new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Configure settings for the most recent game in the channel');

    client.application.commands.set([command]);

    await unlockGames(client);

    client.on('messageCreate', async (message: Message) => {
        try {
            const attachment = message.attachments.find(att => !!ALL.find(ext => endsWith(toLower(att.name), ext)));
            if (!attachment || !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return;
            }

            let game: string;
            let buffer: Buffer;
            let coreType: CoreType;

            if (COMPRESSED.find(ext => endsWith(toLower(attachment.name), ext))) {
                const { body } = await request(attachment.url);

                const files = await decompress(
                    Buffer.from(await body.arrayBuffer()),
                    null,
                    { plugins: [decompressTargz(), decompressTarbz2(), /* decompressTarxz(), */ decompressBzip2()] });

                const entry = files.find(file => detectCore(file.path));

                if (entry) {
                    buffer = entry.data;
                    coreType = detectCore(entry.path);
                    game = path.parse(entry.path).base.replace(/[^0-9a-zA-Z_ \.]/gi, '');
                } else {
                    return;
                }
            } else {
                coreType = detectCore(attachment.name);
                if (!coreType) {
                    return;
                }

                const { body } = await request(attachment.url);
                buffer = Buffer.from(await body.arrayBuffer());
                game = attachment.name;
            }

            message.channel.sendTyping();

            const id = uuid().slice(0, 5);

            const data = path.resolve('data', id);
            shelljs.mkdir('-p', data);

            const gameFile = path.join(data, game);
            fs.writeFileSync(gameFile, buffer);

            const info: GameInfo = {
                game,
                coreType,
                guild: message.guildId,
                channelId: message.channelId,
                inputAssist: InputAssist.Autoplay,
                inputAssistSpeed: InputAssistSpeed.Normal,
                directionPress: DirectionPress.Release
            };

            setGameInfo(id, info);

            const { recording, recordingName, state } = await emulate(pool, coreType, buffer, null, info, []);

            const stateFile = path.join(data, 'state.sav');
            fs.writeFileSync(stateFile, state);

            await message.channel.send({
                files: [{
                    attachment: recording,
                    name: recordingName
                }],
                components: buttons(coreType, id, 1, true),
            });
        } catch (err) {
            console.error(err);
        }
    });

    client.on('interactionCreate', async (interaction: Interaction<CacheType>) => {
        const isAdmin = interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator);

        try {
            if (interaction.isCommand() && isAdmin) {
                if (interaction.commandName == 'settings') {
                    const result = await findMostRecentGame(client, interaction.channelId);

                    if (result) {
                        const { id } = result;
                        const info = getGameInfo(id);

                        await interaction.reply(`Settings for ${info.game}`);

                        for (const setting of settingsForm(result.id, info)) {
                            await interaction.channel.send(setting);
                        }
                    } else {
                        await interaction.reply('Could not find game');
                    }
                }
            }

            if (interaction.isSelectMenu() && isAdmin) {
                const [name, id, setting] = interaction.customId.split('-');

                if (name == 'settings' && isGameId(id)) {
                    const info = getGameInfo(id);

                    if (setting == 'input_assist') {
                        const [value] = interaction.values;
                        switch (value) {
                            case InputAssist.Wait:
                                info.inputAssist = InputAssist.Wait;
                                break;

                            case InputAssist.Off:
                                info.inputAssist = InputAssist.Off;
                                break;

                            default:
                            case InputAssist.Autoplay:
                                info.inputAssist = InputAssist.Autoplay;
                                break;
                        }

                        setGameInfo(id, info);
                        interaction.update(inputAssistSetting(id, info));
                    } else if (setting == 'input_assist_speed') {
                        const [value] = interaction.values;
                        switch (value) {
                            case InputAssistSpeed.Fast:
                                info.inputAssistSpeed = InputAssistSpeed.Fast;
                                break;

                            case InputAssistSpeed.Slow:
                                info.inputAssistSpeed = InputAssistSpeed.Slow;
                                break;

                            default:
                            case InputAssistSpeed.Normal:
                                info.inputAssistSpeed = InputAssistSpeed.Normal;
                                break;
                        }

                        setGameInfo(id, info);
                        interaction.update(inputAssistSpeedSetting(id, info));
                    } else if (setting == 'direction_press') {
                        const [value] = interaction.values;
                        switch (value) {
                            case DirectionPress.Hold:
                                info.directionPress = DirectionPress.Hold;
                                break;

                            default:
                            case DirectionPress.Release:
                                info.directionPress = DirectionPress.Release;
                                break;
                        }

                        setGameInfo(id, info);
                        interaction.update(directionPressSetting(id, info));
                    }
                }
            }

            if (interaction.isButton()) {
                const player = client.guilds.cache.get(interaction.guildId).members.cache.get(interaction.user.id);
                const message = interaction.message;

                const [id, button, multiplier] = interaction.customId.split('-');

                if (isGameId(id)) {
                    const info = getGameInfo(id);

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

                        let game = fs.readFileSync(path.resolve('data', id, info.game))
                        let oldState = fs.readFileSync(path.resolve('data', id, 'state.sav'));

                        const { recording, recordingName, state: newState } = await emulate(pool, info.coreType, game, oldState, info, playerInputs);

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
            }
        } catch (err) {
            console.error(err);
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

const inputAssistSetting = (id, info: GameInfo) => ({
    content: 'Input Assist',
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>()
        .addComponents(new SelectMenuBuilder()
            .setCustomId(`settings-${id}-input_assist`)
            .setOptions({
                label: 'Autoplay',
                value: InputAssist.Autoplay,
                default: info.inputAssist == InputAssist.Autoplay
            }, {
                label: 'Wait',
                value: InputAssist.Wait,
                default: info.inputAssist == InputAssist.Wait
            }, {
                label: 'Off',
                value: InputAssist.Off,
                default: info.inputAssist == InputAssist.Off
            }))]
})

const inputAssistSpeedSetting = (id, info: GameInfo) => ({
    content: 'Input Assist Speed',
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>()
        .addComponents(new SelectMenuBuilder()
            .setCustomId(`settings-${id}-input_assist_speed`)
            .setOptions({
                label: 'Fast',
                value: InputAssistSpeed.Fast,
                default: info.inputAssistSpeed == InputAssistSpeed.Fast
            }, {
                label: 'Normal',
                value: InputAssistSpeed.Normal,
                default: info.inputAssistSpeed == InputAssistSpeed.Normal
            }, {
                label: 'Slow',
                value: InputAssistSpeed.Slow,
                default: info.inputAssistSpeed == InputAssistSpeed.Slow
            }))]
})

const directionPressSetting = (id, info: GameInfo) => ({
    content: 'Directional Press',
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>()
        .addComponents(new SelectMenuBuilder()
            .setCustomId(`settings-${id}-direction_press`)
            .setOptions({
                label: 'Release',
                value: DirectionPress.Release,
                default: info.directionPress == DirectionPress.Release
            }, {
                label: 'Hold',
                value: DirectionPress.Hold,
                default: info.directionPress == DirectionPress.Hold
            }))]
})

const settingsForm = (id: string, info: GameInfo): MessageOptions[] => ([
    inputAssistSetting(id, info),
    inputAssistSpeedSetting(id, info),
    directionPressSetting(id, info)
]);

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

const findMostRecentGame = async (client: Client, channelId: string): Promise<{ id: string, message: Message, channel: TextChannel }> => {
    const channel = await client.channels.fetch(channelId) as TextChannel;
    const messages = await channel.messages.fetch({ limit: 100 });

    for (const message of messages.values()) {
        if (message.author.id == client.user.id) {
            const button = message.components.find(component => component.type == ComponentType.ActionRow)?.components
                ?.find(component => component.type == ComponentType.Button);

            if (button) {
                const id = first(split(button?.customId, '-'));

                if (isGameId(id)) {
                    return { id, message, channel };
                }
            }
        }
    }

    return null;
}

const unlockGames = async (client: Client) => {
    const infoIds = (await glob('data/*/info.json')).map(dir => dir.split(/[\\\/]/).at(-2));
    const infos = reduce(infoIds, (acc, id) => ({
        ...acc,
        [id]: getGameInfo(id)
    }), {} as { [id: string]: GameInfo });

    const channelIds: string[] = uniq(reduce(infos, (acc, info) => [...acc, info.channelId], []));

    for (const channelId of channelIds) {
        try {
            const result = await findMostRecentGame(client, channelId);
            if (result) {
                const { id, message, channel } = result;
                const info = infos[id];

                if (info) {
                    console.log(`unlocking ${info.game} in ${channel.name}`);
                    await message.edit({ components: buttons(info.coreType, id, 1, true) });
                }
            }
        } catch (err) {
            console.log(err);
        }
    }
}

const detectCore = (filename: string): CoreType => {
    if (NES.find(ext => endsWith(toLower(filename), ext)))
        return CoreType.NES;

    if (SNES.find(ext => endsWith(toLower(filename), ext)))
        return CoreType.SNES;

    if (GB.find(ext => endsWith(toLower(filename), ext)))
        return CoreType.GB;

    if (GBA.find(ext => endsWith(toLower(filename), ext)))
        return CoreType.GBA;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});