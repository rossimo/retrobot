import * as path from 'path';
import Piscina from 'piscina';
import EventEmitter from 'events';

import { InputState } from './util';
import { CoreType } from './emulate';
import { Frame } from './worker';

export const emulateParallel = async (pool: Piscina, data: { coreType: CoreType, game: Uint8Array, state: Uint8Array, frames: Frame[], gameHash?: string, stateHash?: string }, options: { input: InputState, duration: number }, signal?: EventEmitter) => {
    let { coreType, game, state, frames, gameHash, stateHash } = data;
    let { input, duration } = options;

    let gameCopy = new Uint8Array(game);
    let stateCopy = new Uint8Array(state);

    const result = await pool.run(
        {
            coreType,
            input,
            duration,
            game: gameCopy,
            state: stateCopy,
            gameHash,
            stateHash
        },
        {
            transferList: [
                gameCopy?.buffer || new ArrayBuffer(0),
                stateCopy?.buffer || new ArrayBuffer(0)
            ],
            signal
        });

    return {
        coreType,
        game,
        state: result.state,
        frames: [...frames, ...result.frames],
        av_info: result.av_info,
        gameHash: result.gameHash,
        stateHash: result.stateHash
    };
}