import { crc32 } from 'hash-wasm';
import * as path from 'path';
import * as sharp from 'sharp';
import { arraysEqual } from './utils';

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
    SELECT?: boolean
    START?: boolean
}

export interface Recording {
    quality: number
    tmpDir: string
    maxFramerate: number
    executedFrameCount: number
    frames: Promise<{ file: string, frameNumber: number }>[]
    lastBuffer: Uint16Array
    lastRecordedBufferHash: any
    framesSinceRecord: number
    width: number
    height: number
}

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

export const executeFrame = async (core: any, input: InputState = {}, recording: Recording = null, count = 1) => {
    let result;

    for (let i = 0; i < count; i++) {
        const frame = await new Promise<Frame>((res) => {
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

                    return mask;
                }

                return 0;
            });

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

        result = frame;

        if (recording) {
            if ((recording.executedFrameCount % 10) == 0) {
                await new Promise(res => setImmediate(res));
            }

            frame.buffer = frame.buffer ? frame.buffer : recording?.lastBuffer;

            recording.lastBuffer = frame.buffer;
            const executedFrameCount = recording.executedFrameCount++;

            const bufferHash = await crc32(frame.buffer);

            if (recording.framesSinceRecord != -1 && (recording.framesSinceRecord < recording.maxFramerate || (bufferHash == recording.lastRecordedBufferHash))) {
                recording.framesSinceRecord++;
                continue;
            }

            recording.framesSinceRecord = 0;
            recording.lastRecordedBufferHash = bufferHash;

            const file = path.join(recording.tmpDir, `frame-${executedFrameCount}.png`);

            recording.frames.push(sharp(rgb565toRaw(frame), {
                raw: {
                    width: frame.width,
                    height: frame.height,
                    channels: 3
                }
            }).resize({
                width: recording.width,
                height: recording.height,
                kernel: sharp.kernel.nearest
            }).png({
                quality: recording.quality
            }).toFile(file).then(() => ({
                file,
                frameNumber: executedFrameCount
            })));
        }
    }

    return result;
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