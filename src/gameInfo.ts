import * as fs from 'fs';
import { CoreType } from "./emulate"

export enum InputAssist {
    Autoplay = 'autoplay',
    Wait = 'wait',
    Off = 'off'
}

export enum InputAssistSpeed {
    Fast = 'fast',
    Normal = 'normal',
    Slow = 'slow'
}

export enum DirectionPress {
    Hold = 'hold',
    Release = 'release'
}

export interface GameInfo {
    game: string
    coreType: CoreType
    guild: string
    channelId: string
    inputAssist: InputAssist
    inputAssistSpeed: InputAssistSpeed
    directionPress: DirectionPress
}

export const isGameId = (id: string) => {
    return fs.existsSync(`data/${id}`);
}

export const getGameInfo = (id: string): GameInfo => {
    const info = JSON.parse(fs.readFileSync(`data/${id}/info.json`).toString());

    return {
        inputAssist: InputAssist.Autoplay,
        inputAssistSpeed: InputAssistSpeed.Normal,
        directionPress: DirectionPress.Release,
        ...info
    }
}

export const setGameInfo = (id: string, info: GameInfo) => {
    return fs.writeFileSync(`data/${id}/info.json`, JSON.stringify(info, null, 4));
}