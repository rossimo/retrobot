import * as path from 'path';

export const loadRom = (core: any, data: ArrayBufferLike) => {
    const pointer = core.asm.malloc(data.byteLength);
    const heap = new Uint8Array(core.HEAPU8.buffer, pointer, data.byteLength);
    heap.set(new Uint8Array(data));

    const result = core.retro_load_game({ data: pointer, size: data.byteLength });
    //core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to load game');
    }
}

export const loadState = (core: any, state: ArrayBufferLike) => {
    const size = core.retro_serialize_size();
    const pointer = core.asm.malloc(size);
    const heap = new Uint8Array(core.HEAPU8.buffer, pointer, size);
    heap.set(new Uint8Array(new Uint8Array(state).slice(0, size)));

    const result = core.retro_unserialize(pointer, size);
    core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to load state');
    }
}

export const saveState = (core: any) => {
    const size = core.retro_serialize_size();
    const pointer = core.asm.malloc(size);

    const result = core.retro_serialize(pointer, size);
    const data = new Uint8Array(new Uint8Array(core.HEAPU8.buffer, pointer, size));
    core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to save state');
    }

    return data;
}

export interface Frame {
    buffer: Uint16Array
    width: number
    height: number
    pitch: number
}

export interface InputState {
    UP?: boolean
    RIGHT?: boolean
    DOWN?: boolean
    LEFT?: boolean
    A?: boolean
    B?: boolean
    X?: boolean
    Y?: boolean
    L?: boolean
    R?: boolean
    SELECT?: boolean
    START?: boolean
}

export interface Recording {
    quality: number
    tmpDir: string
    maxFramerate: number
    executedFrameCount: number
    frames: Promise<{ file: string, frameNumber: number }>[]
    lastFrame: Frame
    lastRecordedBufferHash: any
    framesSinceRecord: number
    width: number
    height: number
}

export const rgb565toRaw = ({ width, height, pitch, buffer }: Frame) => {
    const raw = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = buffer[(pitch * y) / 2 + x];

            const r = (pixel >> 8) & 0xF8;
            const g = (pixel >> 3) & 0xFC;
            const b = (pixel) << 3;

            const i = (x + width * y) * 4;
            raw[i] = r;
            raw[i + 1] = g;
            raw[i + 2] = b;
            raw[i + 3] = 255;
        }
    }

    return raw;
}

export const arraysEqual = (a: Uint16Array, b: Uint16Array) => {
    if (a?.length != b?.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] != b[i]) {
            return false;
        }
    }

    return true;
}

export const isDirection = (input?: InputState) => {
    if (input?.UP) return true;
    if (input?.DOWN) return true;
    if (input?.LEFT) return true;
    if (input?.RIGHT) return true;
    return false;
}