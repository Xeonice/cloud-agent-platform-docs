"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCoordinatorResolver = createCoordinatorResolver;
const zod_1 = require("zod");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const system_clock_1 = require("../time/system-clock");
const CoordinatorBindingSchema = zod_1.z.object({
    instanceId: zod_1.z.string(),
    state: zod_1.z.enum(['ready', 'quiescing']),
    origin: zod_1.z.string(),
    generation: zod_1.z.number().int().positive(),
    artifactDigest: zod_1.z.string(),
});
function createCoordinatorResolver(initial, instanceId, path = process.env.PLATFORM_COORDINATOR_BINDING_PATH) {
    const clock = new system_clock_1.SystemClock();
    if (path && !(0, node_path_1.isAbsolute)(path))
        throw new Error('COORDINATOR_BINDING_PATH_MUST_BE_ABSOLUTE');
    return async (logicalDeadline) => {
        if (!path)
            return initial;
        const deadline = Math.min(clock.now().getTime() + 1750, logicalDeadline ?? Infinity);
        for (;;) {
            const stat = await (0, promises_1.lstat)(path);
            if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
                throw new Error('UNTRUSTED_COORDINATOR_BINDING');
            const value = JSON.parse(await (0, promises_1.readFile)(path, 'utf8'));
            if (!value || typeof value !== 'object')
                throw new Error('INVALID_COORDINATOR_BINDING');
            const binding = CoordinatorBindingSchema.parse(value), target = new URL(binding.origin);
            if (binding.instanceId !== instanceId ||
                !Number.isSafeInteger(binding.generation) ||
                binding.generation < 1 ||
                target.protocol !== 'http:' ||
                !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
                target.username ||
                target.password ||
                target.pathname !== '/' ||
                target.hash ||
                target.search ||
                !/^sha256:[a-f0-9]{64}$/.test(binding.artifactDigest))
                throw new Error('INVALID_COORDINATOR_BINDING');
            if (binding.state === 'ready')
                return target;
            if (clock.now().getTime() >= deadline)
                throw new Error('COORDINATOR_HANDOFF_BUDGET_EXCEEDED');
            // No application command has been dispatched while waiting here.
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
}
//# sourceMappingURL=coordinator-routing.js.map