[![](https://dcbadge.vercel.app/api/server/dbcnjr9tp9)](https://discord.gg/dbcnjr9tp9)

# Retrobot

Retrobot is a Discord bot that allows you to play NES/SNES/GB/GBA games with your friends over chat! Think "TwitchPlaysPokemon", but with GIFs. It accepts button presses, emulates the result, and encodes a GIF to view.

![Example](example.webp)

## Input Assist
Retrobot simplifies control by auto-forwarding through idle parts of games, such as conversations or battle animations. 

Additionally, numbered buttons are added to automatically repeat button presses. This is useful for walking in a specific direction for a long period.

## Settings
You can configure how input assist works, how often input assist activates, and how directional button presses are repeated with the `/settings` command.

![Settings](settings.png)

## How to Use
Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications), and obtain a token for your bot. Also, ensure "Message Content Intent" is enabled for your bot.

![Message Content Intent screenshot](permissions.png)

Create a file name exactly `.env` in your clone of this repository with the following contents:
```
DISCORD_TOKEN=YOUR DISCORD TOKEN HERE
```

Run these commands:
```
yarn install
yarn start
```

Then invite the bot to a server with the following URL. Be sure to update the OAuth Client ID.
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_OAUTH_CLIENT_ID_HERE&permissions=68608&scope=bot
```

Once the bot has joined your Discord server, drop an uncompressed ROM file into a channel. The bot will automatically find the ROM file, and begin emulation. Note: only server "administrators" can start new games.

## Config

There are additional configuration options you can to your `.env` file to tweak performance:

### `MAX_WORKERS`
By default, Retrobot will create a worker thread for each CPU core on the host system. These workers are use parrallelize multiple games, and to split the work for input assist detection. If you're low on RAM, tweaking this number to something small (i.e., `2`) will reduce memory usage at the cost of total emulation time.

### `MAX_WORKERS_PER_GAME`
By default, Retrobot will use 3 input assist worker threads to emulate the result of a button press for a game. Raising this number for faster systems will speed up input assist for games with lots of uninterupptable scenes (conversations, cinematics, etc). Raising this number above `MAX_WORKERS` does not have an effect.

### `RECORDING_FRAMERATE`
By default, Retrobot will encode GIFs at max of 30 FPS. You can configure this to be between 1 and 60 FPS.

### Example
```
DISCORD_TOKEN=YOUR DISCORD TOKEN HERE
MAX_WORKERS=2
RECORDING_FRAMERATE=60
```

## Running as a Daemon
If you'd like a simple way to run the bot as a background service, there's a helper `yarn` script. It will fire up the bot as a background service, and record logs to `./forever/retrobot.log`
```
yarn service:start
```
And to stop:
```
yarn service:stop
```

## Running via Docker Compose

Requires Docker and Docker Compose is installed on the machine.

- Rename `docker-compose.yml.example` to `docker-compose.yml`
- Edit `docker-compose.yml` and your Discord bot token.
- Run `docker-compose build`
- Run `docker-compose up -d`

## Technical Notes
Retrobot is built on [`libretro`](https://github.com/libretro/libretro-common), the code that powers [RetroArch](https://www.retroarch.com/). Several `libretro` cores have been cross-compiled to WASM to be used in [Node.js](https://www.retroarch.com/). Since WASM modules have independent memory spaces, it means several cores of the same type can be instanced. This allows parallelism.

## License
The bot source code here is licensed as MIT. The `libretro` core each have their own licenses.
* mGBA - https://github.com/libretro/mgba/blob/master/LICENSE
* QuickNES - https://github.com/libretro/QuickNES_Core/blob/master/LICENSE
* snes9x2010 - https://github.com/libretro/snes9x2010/blob/master/LICENSE.txt
