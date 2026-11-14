"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemClock = void 0;
const common_1 = require("@nestjs/common");
/**
 * Clock port implementation — the ONE sanctioned place `new Date()` is allowed
 * (eslint no-restricted-syntax is disabled for this folder; 01 §3 "端口实现处豁免").
 */
let SystemClock = class SystemClock {
    now() {
        return new Date();
    }
};
exports.SystemClock = SystemClock;
exports.SystemClock = SystemClock = __decorate([
    (0, common_1.Injectable)()
], SystemClock);
//# sourceMappingURL=system-clock.js.map