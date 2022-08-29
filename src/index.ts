import 'dotenv/config';
import * as fs from 'fs';
import { last, toLower, range } from 'lodash';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, CacheType, Client, GatewayIntentBits, Interaction, TextChannel, GuildMember } from 'discord.js';

import { InputState } from './util';
import { CoreType, emulate } from './emulate';

const main = async () => {
    const args = process.argv.slice(2);

    let playerInputs = args.map(arg => parseInput(arg));;
    let player: GuildMember;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    await client.login(process.env.DISCORD_TOKEN);
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID) as TextChannel;
    console.log('online');

    while (true) {
        const game = fs.readFileSync('ffiii.sfc').buffer;

        const savedState = fs.existsSync('state.sav')
            ? fs.readFileSync('state.sav').buffer
            : null;

        const { recording, recordingName, state } = await emulate(CoreType.SNES, game, savedState, playerInputs);

        fs.writeFileSync('state.sav', state);

        const button = last(playerInputs);
        console.log(`Sending...`);

        const message = await channel.send({
            content: player && button ? `${player.nickname || player.displayName} pressed ${joyToWord(button)}...` : undefined,
            files: [{
                attachment: recording,
                name: recordingName
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