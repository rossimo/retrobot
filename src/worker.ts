import { InputState, loadRom, loadState } from "./util";

interface Data {
    input: InputState
    duration: number
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

export interface Frame {
    buffer: Uint16Array
    width: number
    height: number
    pitch: number
}

type Core = any

interface Runtime {
    core: Core
    
}

const worker = (core: any) => async (data: Data, transferList: ArrayBuffer[]) => {
    const [rom, state] = transferList;
    const { input, duration } = data;

    loadRom(core, rom);

    if (state) {
        loadState(core, state);
    }

    const executFrame = () => new Promise<Frame>((res) => {
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

    const frames: Frame[] = [];

    for (let i = 0; i < duration; i++) {
        frames.push(await executFrame());
    }

}