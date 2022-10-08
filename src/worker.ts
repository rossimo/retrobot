import Piscina from 'piscina';
import { CoreType } from './emulate';
import { crc32c } from 'hash-wasm';
import { InputState, loadRom, loadState, saveState } from './util';

export const RETRO_DEVICE_ID_JOYPAD_B = 0;
export const RETRO_DEVICE_ID_JOYPAD_Y = 1;
export const RETRO_DEVICE_ID_JOYPAD_SELECT = 2;
export const RETRO_DEVICE_ID_JOYPAD_START = 3;
export const RETRO_DEVICE_ID_JOYPAD_UP = 4;
export const RETRO_DEVICE_ID_JOYPAD_DOWN = 5;
export const RETRO_DEVICE_ID_JOYPAD_LEFT = 6;
export const RETRO_DEVICE_ID_JOYPAD_RIGHT = 7;
export const RETRO_DEVICE_ID_JOYPAD_A = 8;
export const RETRO_DEVICE_ID_JOYPAD_X = 9;
export const RETRO_DEVICE_ID_JOYPAD_L = 10;
export const RETRO_DEVICE_ID_JOYPAD_R = 11;
export const RETRO_DEVICE_ID_JOYPAD_L2 = 12;
export const RETRO_DEVICE_ID_JOYPAD_R2 = 13;
export const RETRO_DEVICE_ID_JOYPAD_L3 = 14;
export const RETRO_DEVICE_ID_JOYPAD_R3 = 15;

export const RETRO_DEVICE_ID_JOYPAD_MASK = 256;

type Core = any

export interface Frame {
    buffer: Uint16Array
    width: number
    height: number
    pitch: number
}

export interface WorkerData {
    input: InputState
    duration: number
    coreType: CoreType
    game: Buffer
    state: Buffer
    gameHash?: string
    stateHash?: string
}

const NesCore = require('../cores/quicknes_libretro');
const SnesCore = require('../cores/snes9x2010_libretro');
const GbCore = require('../cores/mgba_libretro');
const GenesisCore = require('../cores/genesis_plus_gx_libretro');

let lastGbGameHash = '';
let lastNesGameHash = '';
let lastSnesGameHash = '';
let lastGenesisGameHash = '';

let lastGbStateHash = '';
let lastNesStateHash = '';
let lastSnesStateHash = '';
let lastGenesisStateHash = '';

const setup = (core: Core) => {
    core.retro_set_environment((cmd: number, data: any) => {
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
    });

    return core;
};

let nesCoreInit: Promise<Core>;
let snesCoreInit: Promise<Core>;
let gbCoreInit: Promise<Core>;
let genesisCoreInit: Promise<Core>;

export default async (data: WorkerData) => {
    const { coreType, input, duration, game, state, gameHash, stateHash } = data;

    let core: Core;
    switch (coreType) {
        case CoreType.NES:
            core = await (nesCoreInit = nesCoreInit || NesCore().then(setup));
            break;

        case CoreType.SNES:
            core = await (snesCoreInit = snesCoreInit || SnesCore().then(setup));
            break;

        case CoreType.GBA:
        case CoreType.GB:
            core = await (gbCoreInit = gbCoreInit || GbCore().then(setup));
            break;

        case CoreType.GENESIS:
            core = await (genesisCoreInit = genesisCoreInit || GenesisCore().then(setup));
            break;

        default:
            throw new Error(`Unknown core type: ${coreType}`);
    }

    const incomingGameHash = gameHash
        ? gameHash
        : await crc32c(game);

    let lastGameHash = '';

    switch (coreType) {
        case CoreType.NES:
            lastGameHash = lastNesGameHash;
            break;

        case CoreType.SNES:
            lastGameHash = lastSnesGameHash;
            break;

        case CoreType.GBA:
        case CoreType.GB:
            lastGameHash = lastGbGameHash;
            break;

        case CoreType.GENESIS:
            lastGameHash = lastGenesisGameHash;
            break;
    }

    if (incomingGameHash != lastGameHash || state?.byteLength == 0) {
        loadRom(core, game);

        switch (coreType) {
            case CoreType.NES:
                lastNesGameHash = incomingGameHash;
                break;

            case CoreType.SNES:
                lastSnesGameHash = incomingGameHash;
                break;

            case CoreType.GBA:
            case CoreType.GB:
                lastGbGameHash = incomingGameHash;
                break;

            case CoreType.GENESIS:
                lastGenesisGameHash = incomingGameHash;
                break;
        }
    }

    const av_info: any = {};
    core.retro_get_system_av_info(av_info);

    {
        const incomingStateHash = stateHash
            ? stateHash
            : await crc32c(state);

        let lastStateHash: string;
        switch (coreType) {
            case CoreType.NES:
                lastStateHash = lastNesStateHash;
                break;

            case CoreType.SNES:
                lastStateHash = lastSnesStateHash;
                break;

            case CoreType.GBA:
            case CoreType.GB:
                lastStateHash = lastGbStateHash;
                break;

            case CoreType.GENESIS:
                lastStateHash = lastGenesisStateHash;
                break;
        }

        if (state?.byteLength > 0 && lastStateHash != incomingStateHash) {
            loadState(core, state);
        }
    }

    core.retro_set_input_state((port: number, device: number, index: number, id: number) => {
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
            let mask = 0;

            if (input.A)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_A;

            if (input.B)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_B;

            if (input.X)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_X;

            if (input.Y)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_Y;

            if (input.SELECT)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_SELECT;

            if (input.START)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_START;

            if (input.UP)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_UP;

            if (input.DOWN)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_DOWN;

            if (input.LEFT)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_LEFT;

            if (input.RIGHT)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_RIGHT;

            if (input.L)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_L;

            if (input.R)
                mask |= 1 << RETRO_DEVICE_ID_JOYPAD_R;

            return mask;
        }

        return 0;
    });

    let callback: (frame: Frame) => void;
    core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
        callback({
            buffer: data
                ? new Uint16Array(core.HEAPU16.subarray(data / 2, (data + pitch * height) / 2))
                : null,
            width,
            height,
            pitch
        });
    });

    const executeFrame = () => new Promise<Frame>((res) => {
        callback = res;
        core.retro_run();
    });

    const frames: Frame[] = [];

    for (let i = 0; i < duration; i++) {
        frames.push(await executeFrame());
    }

    const newState = saveState(core);
    const newStateHash = await crc32c(newState);

    switch (coreType) {
        case CoreType.NES:
            lastNesStateHash = newStateHash;
            break;

        case CoreType.SNES:
            lastSnesStateHash = newStateHash;
            break;

        case CoreType.GBA:
        case CoreType.GB:
            lastGbStateHash = newStateHash;
            break;

        case CoreType.GENESIS:
            lastGenesisStateHash = newStateHash;
            break;
    }

    const output = {
        av_info,
        frames,
        state: newState,
        gameHash: incomingGameHash,
        stateHash: newStateHash,

        get [Piscina.transferableSymbol]() {
            return [
                newState.buffer,
                ...frames.map(frame => frame.buffer.buffer)
            ];
        },

        get [Piscina.valueSymbol]() {
            return {
                av_info,
                frames,
                state: newState,
                gameHash: incomingGameHash,
                stateHash: newStateHash
            };
        }
    };

    return Piscina.move(output as any);
}