import 'dotenv/config';
import { has, parseInt } from 'lodash';

export const MAX_WORKERS = has(process.env, 'MAX_WORKERS')
    ? parseInt(process.env.MAX_WORKERS)
    : -1;

export const MAX_WORKERS_PER_GAME = has(process.env, 'MAX_WORKERS_PER_GAME')
    ? parseInt(process.env.MAX_WORKERS_PER_GAME)
    : 3;

export const RECORDING_FRAMERATE = Math.max(Math.min(has(process.env, 'RECORDING_FRAMERATE')
    ? parseInt(process.env.RECORDING_FRAMERATE)
    : 30, 60), 1);