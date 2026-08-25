// 128×128 RGB PNG：四个纯色象限与白色对角线。它既足够小，也满足视觉 provider
// 对“人类可理解”输入的要求；1×1 像素虽是合法 PNG，但会被真实 VLM 拒绝。
export const CHECKPOINT_IMAGE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAADXElEQVR42u3cy1EcQRRE0fSFdfvCGmPZ4Mus8QCFghBCMz091VXvk5fQi3Sg7tmXPv7cZduI216fifvKro9v9x+guP41ANEAXf83wGXb0Abo+tvrsz6fwTVA1/8LwDVA1/8HAGqArn8NQDRA198BwBmg6+8DsAzQ9e8CgAzQ9Y8AKAbo+g8AEAbo+o8B/A3Q9YcAzA3Q9UcBnA3Q9U8A2Bqg658D8DRA1z8NYGiArj8D4GaArj8JYGWArj8P4GOArr8EYGKArr8K4GCArh8A0G6Arh8D0GuArh8G0GiArh8J0GWArh8M0GKArh8PUG+Arp8CUGyArp8FUGmArp8IUGaArp8LUGOArp8OUGCArl8BkG2Arl8EkGqArl8HkGeArl8KkGSArl8NkGGArt8AEG6Art8DEGuArt8GEGiArt8JEGWArt8MEGKArt8PsG6Arm8BsGiAru8CsGKArm8EMG2Aru8FMGeArm8HMGGAru8IcNYAXd8U4JQBur4vwLgBur41wKABur47wIgBuj4A4KEBuj4D4NgAXR8DcGCArk8CuGeArg8D2DVA1+cB3Bqg6yMBDgyIH3kjAXYNoP/Ya3u5EHcL8P72RJx+Rn2ugX5MfaiB0PW3l8v72xPaQOj6nwBoA6HrfwFwDYSu/x0AaiB0/SsAooHQ9W8BcAZC198FYBkIXf8eAMhA6PoHABQDoesfAyAMhK7/EMDfQOj6IwDmBkLXHwRwNhC6/jiArYHQ9U8BeBoIXf8sgKGB0PUnANwMhK4/B2BlIHT9aQAfA6HrrwCYGAhdfxHAwUDo+usA7QZC1w8B6DUQun4UQKOB0PUDAboMhK4fC9BiIHT9cIB6A6HrZwAUGwhdPwmg0kDo+nkAZQZC108FqDEQun42QIGB0PULALINhK5fA5BqIHT9MoA8A6HrVwIkGQhdvxggw0Do+vUA4QZC128BiDUQun4XQKCB0PUbAaIMhK7fCxBiIHT9doB1A6HrOwAsGghd3wRgxUDo+j4A0wZC17cCmDMQur4bwISB0PUNAc4aCF3fE+CUgdD1bQHGDYSu7wwwaCB0fXOAEQOh6/sDPDQQuj4C4NhA6PoUgAMDoeuDAO4ZCF2fBbBrIHR9HMCtgdD1iQBXBkLXhwJ8N/gF1oiECt31UOcAAAAASUVORK5CYII=";

export function checkpointOverview(goal = "continue the verified task") {
  return `# Working Memory

## Task & Goals
- ${goal}

## Current State
- The latest verified context has been incorporated

## Key Facts & Decisions
- Preserve source-backed facts and unfinished obligations
- The current continuation boundary is verified

## Open Issues
- Complete the remaining task

## Next Action
- Continue from the latest verified boundary

## Files & Context
- Source Archive and checkpoint identities remain authoritative

## Errors & Corrections
- No errors or corrections are pending`;
}
