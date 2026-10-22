/**
 * CallManager - Call state manager
 * Manage device-to-device calls, including mutual-call pairing and remote wake-up
 */
class CallManager {
    constructor(config = {}) {
        // mac => { targetMac, callerNickname, timestamp }
        this.pendingCalls = new Map();
        // mac => targetMac (bidirectional mapping)
        this.activeCalls = new Map();
        // mac => session_id (call-mode session_id sent to the peer in goodbye)
        this.callSessionIds = new Map();
        this.getConnectionByMac = null;  // (mac) => MQTTConnection
    }

    /**
     * Request a call
     * @param {string} callerMac - Caller MAC
     * @param {string} targetMac - Callee MAC
     * @param {string} callerNickname - Caller nickname used for remote wake-up
     * @returns {{status: 'pending' | 'bridged', message?: string}}
     */
    requestCall(callerMac, targetMac, callerNickname) {
        // Normalize MAC addresses
        callerMac = callerMac.toLowerCase();
        targetMac = targetMac.toLowerCase();

        // Check whether the caller is already in a call
        if (this.activeCalls.has(callerMac)) {
            return { status: 'error', message: '已在通话中' };
        }

        // Check for a reciprocal pending call (mutual-call pairing)
        const pendingTarget = this.pendingCalls.get(targetMac);
        if (pendingTarget && pendingTarget.targetMac === callerMac) {
            // Pair the reciprocal calls and establish a bridge
            this.pendingCalls.delete(callerMac);
            this.pendingCalls.delete(targetMac);
            this.activeCalls.set(callerMac, targetMac);
            this.activeCalls.set(targetMac, callerMac);
            console.log(`Call established: ${callerMac} <-> ${targetMac}`);
            return { status: 'bridged', peerMac: targetMac };
        }

        // A one-sided request needs a remote wake-up of the peer
        this.pendingCalls.set(callerMac, {
            targetMac,
            callerNickname,
            timestamp: Date.now()
        });
        console.log(`Call request recorded: ${callerMac} -> ${targetMac}, waiting for the peer to answer`);

        return { status: 'pending' };
    }

    /**
     * Handle the callee joining a call
     * @param {string} calleeMac - Callee MAC (the party answering the call)
     * @returns {{status: 'bridged' | 'no_pending' | 'caller_gone' | 'error', message?: string, peerMac?: string}}
     */
    joinCall(calleeMac) {
        calleeMac = calleeMac.toLowerCase();

        // Find a call waiting for this device (pendingEntry.targetMac === calleeMac)
        let pendingEntry = null;
        let callerMac = null;
        for (const [mac, entry] of this.pendingCalls) {
            if (entry.targetMac === calleeMac) {
                callerMac = mac;
                pendingEntry = entry;
                break;
            }
        }

        if (!pendingEntry) {
            return { status: 'no_pending', message: '没有等待中的通话' };
        }

        // Check whether the caller is still pending
        const callerPending = this.pendingCalls.get(callerMac);
        if (!callerPending || callerPending.targetMac !== calleeMac) {
            return { status: 'caller_gone', message: '主叫方已离开或通话已超时' };
        }

        // Establish the bridge
        this.pendingCalls.delete(callerMac);
        this.pendingCalls.delete(calleeMac);
        this.activeCalls.set(callerMac, calleeMac);
        this.activeCalls.set(calleeMac, callerMac);
        console.log(`Call established: ${callerMac} <-> ${calleeMac}`);
        return { status: 'bridged', peerMac: callerMac };
    }

    /**
     * Check whether the device has an active or pending call
     */
    isInCall(mac) {
        const lowerMac = mac?.toLowerCase();
        return this.activeCalls.has(lowerMac) || this.pendingCalls.has(lowerMac);
    }

    /**
     * Get the peer's connection
     */
    getPeerConnection(mac) {
        const peerMac = this.activeCalls.get(mac?.toLowerCase());
        if (!peerMac || !this.getConnectionByMac) return null;
        return this.getConnectionByMac(peerMac);
    }

    /**
     * Set the session_id used in call mode
     */
    setCallSessionId(mac, sessionId) {
        this.callSessionIds.set(mac?.toLowerCase(), sessionId);
    }

    /**
     * Get the session_id used in call mode
     */
    getCallSessionId(mac) {
        return this.callSessionIds.get(mac?.toLowerCase());
    }

    /**
     * Clear the device's call state
     * @returns {{ pendingCleared: boolean, peerMac: string|null, fromPending: boolean, sessionId?: string }}
     * Return information about the cleared call's peer
     */
    clearDevice(mac) {
        const lowerMac = mac?.toLowerCase();

        // Check pendingCalls
        const pendingEntry = this.pendingCalls.get(lowerMac);
        if (pendingEntry) {
            this.pendingCalls.delete(lowerMac);
            const sessionId = this.callSessionIds.get(lowerMac);
            this.callSessionIds.delete(lowerMac);
            return { pendingCleared: true, peerMac: pendingEntry.targetMac, fromPending: true, sessionId };
        }

        // Check activeCalls
        const peerMac = this.activeCalls.get(lowerMac);
        if (peerMac) {
            this.activeCalls.delete(lowerMac);
            this.activeCalls.delete(peerMac);
            const sessionId = this.callSessionIds.get(lowerMac);
            this.callSessionIds.delete(lowerMac);
            return { pendingCleared: false, peerMac, fromPending: false, sessionId };
        }

        return { pendingCleared: false, peerMac: null, fromPending: false, sessionId: null };
    }

    /**
     * Get active calls
     */
    getActiveCalls() {
        const calls = [];
        for (const [mac1, mac2] of this.activeCalls) {
            if (mac1 < mac2) {
                calls.push({ device1: mac1, device2: mac2 });
            }
        }
        return calls;
    }

    /**
     * Get pending calls
     */
    getPendingCalls() {
        return Array.from(this.pendingCalls.entries()).map(([callerMac, entry]) => ({
            callerMac,
            targetMac: entry.targetMac,
            callerNickname: entry.callerNickname,
            timestamp: entry.timestamp
        }));
    }

    /**
     * Clean up pending calls older than timeoutMs
     * @returns {Array} Cleared entries [{mac, entry, peerMac}]
     */
    cleanupTimeoutCalls(timeoutMs = 60000) {
        const now = Date.now();
        const cleaned = [];
        for (const [mac, entry] of this.pendingCalls) {
            if (now - entry.timestamp > timeoutMs) {
                console.log(`Cleaning up timed-out call request: ${mac} -> ${entry.targetMac}`);
                this.pendingCalls.delete(mac);
                cleaned.push({ mac, entry, peerMac: entry.targetMac });
            }
        }
        return cleaned;
    }
}

module.exports = { CallManager };
