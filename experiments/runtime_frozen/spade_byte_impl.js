/**
 * SPADE cache.
 *
 * Two FIFO queues plus a key-only ghost, same shape as S3-FIFO.
 * Any hit sets a frequency bit, including a repeat by the same requester.
 * That bit keeps the object for one more pass. A new requester moves the
 * object to the tail of the shared queue. The same requester does not
 * reorder it, and no requester prepays an extra copy.
 */

class SpadeCache {
    constructor(maxBytes, maxEntries, options = {}) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.admitFraction = options.admitFraction === undefined ? 0.2 : options.admitFraction;
        this.maxRequesters = options.maxRequesters === undefined ? 16 : options.maxRequesters;
        this.shieldMaxBytes = options.shieldMaxBytes === undefined ? Math.max(1, Math.floor(maxBytes * 0.08)) : options.shieldMaxBytes;
        this.shieldTtlMs = options.shieldTtlMs === undefined ? 5000 : options.shieldTtlMs;
        this.shieldBytes = 0;
        this.now = 0;

        this.admitMaxBytes = Math.max(1, Math.floor(maxBytes * this.admitFraction));
        this.sharedMaxBytes = maxBytes - this.admitMaxBytes;
        this.admitMaxEntries = Math.max(1, Math.floor(maxEntries * this.admitFraction));
        this.sharedMaxEntries = Math.max(1, maxEntries - this.admitMaxEntries);
        this.ghostMaxEntries = maxEntries;

        this.admitQueue = [];
        this.sharedQueue = [];
        this.ghostQueue = [];
        this.cache = new Map();
        this.ghost = new Map();
        this.admitBytes = 0;
        this.sharedBytes = 0;

        this.stats = {
            hits: 0,
            misses: 0,
            ghostMisses: 0,
            insertions: 0,
            promotions: 0,
            budgetAdds: 0,
            rotations: 0,
            reorders: 0,
            shields: 0,
            shieldSkips: 0,
            admitEvictions: 0,
            sharedEvictions: 0
        };
    }

    get(key, requesterId, now) {
        if (Number.isFinite(now)) this.now = now;
        const entry = this.cache.get(key);
        if (entry) {
            entry.freq = 1;
            this._noteRequester(entry, requesterId);
            this.stats.hits++;
            return entry.data;
        }
        if (this.ghost.has(key)) {
            this.stats.ghostMisses++;
            this.stats.misses++;
            return undefined;
        }
        this.stats.misses++;
        return undefined;
    }

    set(key, data, size, requesterId, now) {
        if (Number.isFinite(now)) this.now = now;
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            this._retargetBytes(entry, size);
            entry.data = data;
            this._noteRequester(entry, requesterId);
            return;
        }

        const ghost = this.ghost.get(key);
        if (ghost) {
            this._removeGhost(key);
            const budget = 0;
            this._insertShared(key, data, size, requesterId, budget, ghost.requesters);
            this.stats.insertions++;
            return;
        }

        this._insertAdmit(key, data, size, requesterId);
        this.stats.insertions++;
    }

    _noteRequester(entry, requesterId) {
        if (requesterId === undefined || requesterId === null) return;
        if (entry.requesters.has(requesterId)) return;
        if (entry.requesters.size >= this.maxRequesters) return;
        entry.requesters.add(requesterId);
        this._refreshTail(entry);
    }

    _releaseExpired() {
        for (const entry of this.cache.values()) {
            if (!entry.shieldUntil || entry.shieldUntil > this.now) continue;
            this.shieldBytes -= entry.size;
            entry.shieldUntil = 0;
        }
        if (this.shieldBytes < 0) this.shieldBytes = 0;
    }

    _shielded(entry) {
        return Boolean(entry && entry.shieldUntil > this.now);
    }

    _protect(entry) {
        if (!this.now) return;
        this._releaseExpired();
        if (entry.shieldUntil > this.now) return;
        if (entry.size > this.shieldMaxBytes) return;
        if (this.shieldBytes + entry.size > this.shieldMaxBytes) return;
        entry.shieldUntil = this.now + this.shieldTtlMs;
        this.shieldBytes += entry.size;
        this.stats.shields++;
        if (entry.location === "admit") this._moveShieldToShared(entry);
    }

    _moveShieldToShared(entry) {
        const index = this.admitQueue.indexOf(entry.key);
        if (index !== -1) this.admitQueue.splice(index, 1);
        this.admitBytes -= entry.size;
        entry.location = "shared";
        entry.budget = 0;
        this.sharedQueue.push(entry.key);
        this.sharedBytes += entry.size;
        this.stats.promotions++;
        this._fitShared();
    }

    _refreshTail(entry) {
        if (entry.location === "admit") {
            const index = this.admitQueue.indexOf(entry.key);
            if (index !== -1) this.admitQueue.splice(index, 1);
            this.admitBytes -= entry.size;
            entry.location = "shared";
            entry.budget = 0;
            this.sharedQueue.push(entry.key);
            this.sharedBytes += entry.size;
            this.stats.promotions++;
            this._fitShared();
            return;
        }
        const index = this.sharedQueue.indexOf(entry.key);
        if (index !== -1) this.sharedQueue.splice(index, 1);
        this.sharedQueue.push(entry.key);
        this.stats.reorders++;
    }

    _insertAdmit(key, data, size, requesterId) {
        this._fitAdmit(size);
        const requesters = new Set();
        if (requesterId !== undefined && requesterId !== null) requesters.add(requesterId);
        this.cache.set(key, {
            key, data, size, budget: 0, freq: 0, location: 'admit', requesters
        });
        this.admitQueue.push(key);
        this.admitBytes += size;
        this._enforce(key);
    }

    _insertShared(key, data, size, requesterId, budget, priorRequesters) {
        const requesters = new Set(priorRequesters || []);
        if (requesterId !== undefined && requesterId !== null && requesters.size < this.maxRequesters) {
            requesters.add(requesterId);
        }
        this.cache.set(key, {
            key, data, size, budget, freq: 0, location: 'shared', requesters
        });
        this.sharedQueue.push(key);
        this.sharedBytes += size;
        this._fitShared();
    }

    _fitAdmit(extraBytes) {
        while (this._admitOver(extraBytes)) {
            if (!this._evictAdmit()) break;
        }
    }

    _enforce(keepKey) {
        let spins = 0;
        const limit = (this.sharedQueue.length + this.admitQueue.length + 1) * (this.maxRequesters + 2);
        while (this._totalOver() && spins < limit) {
            spins++;
            const admitVictim = this.admitQueue.find((key) => key !== keepKey);
            if (admitVictim !== undefined) {
                this._evictAdmitKey(admitVictim);
                continue;
            }
            if (this.sharedQueue.length > 0) {
                if (!this._evictOrRotateShared()) break;
                continue;
            }
            if (keepKey !== undefined && this.admitQueue[0] === keepKey) {
                this._evictAdmit();
            }
            break;
        }
        while (this.admitQueue.length > 1 && this.admitBytes > this.admitMaxBytes) {
            const victim = this.admitQueue.find((key) => key !== keepKey) || this.admitQueue[0];
            this._evictAdmitKey(victim);
        }
    }

    _fitShared() {
        this._enforce();
    }

    _evictAdmit() {
        const key = this.admitQueue[0];
        if (key === undefined) return false;
        return this._evictAdmitKey(key);
    }

    _evictAdmitKey(key) {
        const index = this.admitQueue.indexOf(key);
        if (index === -1) return false;
        this.admitQueue.splice(index, 1);
        const entry = this.cache.get(key);
        if (!entry) return true;
        this.admitBytes -= entry.size;
        if (this._shielded(entry)) {
            entry.location = "shared";
            entry.budget = 0;
            this.sharedQueue.push(key);
            this.sharedBytes += entry.size;
            this.stats.shieldSkips++;
            return true;
        }
        if (entry.freq) {
            entry.freq = 0;
            entry.location = 'shared';
            entry.budget = 0;
            this.sharedQueue.push(key);
            this.sharedBytes += entry.size;
            this.stats.promotions++;
            return true;
        }
        this.cache.delete(key);
        this._addGhost(key, entry);
        this.stats.admitEvictions++;
        return true;
    }

    _evictOrRotateShared() {
        const key = this.sharedQueue.shift();
        if (key === undefined) return false;
        const entry = this.cache.get(key);
        if (!entry) return true;
        if (this._shielded(entry)) {
            this.sharedQueue.push(key);
            this.stats.shieldSkips++;
            return true;
        }
        if (entry.freq) {
            entry.freq = 0;
            this.sharedQueue.push(key);
            this.stats.rotations++;
            return true;
        }
        this.sharedBytes -= entry.size;
        this.cache.delete(key);
        this.stats.sharedEvictions++;
        return true;
    }

    _forceEvictShared() {
        const key = this.sharedQueue.shift();
        if (key === undefined) return false;
        const entry = this.cache.get(key);
        if (!entry) return true;
        this.sharedBytes -= entry.size;
        this.cache.delete(key);
        this._addGhost(key, entry);
        this.stats.sharedEvictions++;
        return true;
    }

    _addGhost(key, entry) {
        while (this.ghostQueue.length >= this.ghostMaxEntries) {
            const old = this.ghostQueue.shift();
            this.ghost.delete(old);
        }
        this.ghostQueue.push(key);
        this.ghost.set(key, {
            budget: entry.budget,
            requesters: new Set(entry.requesters)
        });
    }

    _removeGhost(key) {
        const index = this.ghostQueue.indexOf(key);
        if (index !== -1) this.ghostQueue.splice(index, 1);
        this.ghost.delete(key);
    }

    _retargetBytes(entry, size) {
        const delta = size - entry.size;
        if (entry.location === 'admit') this.admitBytes += delta;
        else this.sharedBytes += delta;
        entry.size = size;
    }

    _admitOver(extraBytes) {
        return (this.admitBytes + extraBytes) > this.admitMaxBytes
            || this.admitQueue.length >= this.admitMaxEntries;
    }

    _sharedOver(extraBytes) {
        return (this.sharedBytes + extraBytes) > this.sharedMaxBytes
            || this.sharedQueue.length >= this.sharedMaxEntries;
    }

    _totalOver() {
        return (this.admitBytes + this.sharedBytes) > this.maxBytes
            || (this.admitQueue.length + this.sharedQueue.length) > this.maxEntries;
    }

    has(key) {
        return this.cache.has(key);
    }

    budgetOf(key) {
        const entry = this.cache.get(key);
        return entry ? entry.budget : 0;
    }

    locationOf(key) {
        const entry = this.cache.get(key);
        return entry ? entry.location : null;
    }
}

module.exports = { SpadeCache };
