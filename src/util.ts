export const loadRom = (core: any, data: ArrayBufferLike) => {
    const pointer = core.asm.malloc(data.byteLength);
    const heap = new Uint8Array(core.HEAPU8.buffer, pointer, data.byteLength);
    heap.set(new Uint8Array(data));

    const result = core.retro_load_game({ data: pointer, size: data.byteLength });
    core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to load game');
    }
}

export const loadState = (core: any, state: ArrayBufferLike) => {
    const pointer = core.asm.malloc(state.byteLength);
    const heap = new Uint8Array(core.HEAPU8.buffer, pointer, state.byteLength);
    heap.set(new Uint8Array(state));

    const result = core.retro_unserialize(pointer, state.byteLength);
    core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to load state');
    }
}

export const saveState = (core: any) => {
    const size = core.retro_serialize_size();
    const pointer = core.asm.malloc(size);

    const result = core.retro_serialize(pointer, size);
    core.asm.free(pointer);

    if (!result) {
        throw new Error('Unable to save state');
    }

    return new Uint8Array(core.HEAPU8.buffer, pointer, size);
}

export interface Frame {
    buffer: Uint16Array
    width: number
    height: number
    pitch: number
}

export const executeFrame = async (core: any) => {
    return await new Promise<Frame>((res) => {
        core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
            res({
                buffer: data
                    ? new Uint16Array(core.HEAPU16.subarray(data / 2, (data + pitch * height) / 2))
                    : null,
                width,
                height,
                pitch
            })
        });

        core.retro_run();
    });
}

export const rgb565toRaw = ({ width, height, pitch, buffer }: Frame) => {
    const raw = new Uint8Array(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = buffer[(pitch * y) / 2 + x];

            const r = (pixel >> 8) & 0xF8;
            const g = (pixel >> 3) & 0xFC;
            const b = (pixel) << 3;

            const i = (x + width * y) * 3;
            raw[i] = r;
            raw[i + 1] = g;
            raw[i + 2] = b;
        }
    }

    return raw;
}