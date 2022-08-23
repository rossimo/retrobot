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