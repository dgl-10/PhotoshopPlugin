'use strict';

// Diagnostic state
const pageLoadTime = new Date();
let stressItemCount = 5;

// Agent setup commands dictionary
const AGENT_TEMPLATES = {
    claude: {
        name: 'Claude Code',
        command: 'claude mcp add --transport http photoshop-helper http://127.0.0.1:18345/mcp --header "Authorization: Bearer ${PHOTOSHOP_HELPER_LOCAL_API_TOKEN}"',
        note: 'Claude Code expands ${VAR} from the environment when it connects.'
    },
    codex: {
        name: 'OpenAI Codex',
        command: 'codex mcp add photoshop-helper --url http://127.0.0.1:18345/mcp --bearer-token-env-var PHOTOSHOP_HELPER_LOCAL_API_TOKEN',
        note: 'Codex reads the token from the environment variable by name.'
    },
    grok: {
        name: 'xAI Grok',
        command: 'grok mcp add --transport http photoshop-helper http://127.0.0.1:18345/mcp --header "Authorization: Bearer ${PHOTOSHOP_HELPER_LOCAL_API_TOKEN}"',
        note: 'Grok stores ${VAR} unchanged in ~/.grok/config.toml and expands it at load.'
    },
    agy: {
        name: 'Google Antigravity',
        command: 'agy mcp add --header "Authorization: Bearer $env:PHOTOSHOP_HELPER_LOCAL_API_TOKEN" photoshop-helper http://127.0.0.1:18345/mcp',
        note: 'Antigravity expands the environment variable via the shell at install time.'
    }
};

let currentInstructionText = '';

// DOM Elements
const agentSelect = document.getElementById('agent-select');
const instructionBox = document.getElementById('instruction-box');
const copyBtn = document.getElementById('copy-btn');
const toggleTextBtn = document.getElementById('toggle-text-btn');
const liveCounterEl = document.getElementById('live-counter');
const liveUptimeEl = document.getElementById('live-uptime');
const liveClockEl = document.getElementById('live-clock');
const stressList = document.getElementById('stress-list');
const addStepsBtn = document.getElementById('add-steps-btn');
const removeStepsBtn = document.getElementById('remove-steps-btn');
const msgLogBox = document.getElementById('msg-log');
const pingBtn = document.getElementById('ping-btn');
const closeBtn = document.getElementById('close-dialog-btn');
const openViaBridgeBtn = document.getElementById('open-via-bridge-btn');
const bridgeBadge = document.getElementById('bridge-badge');

// Diagnostics Elements
const diagUa = document.getElementById('diag-ua');
const diagDpr = document.getElementById('diag-dpr');
const diagViewport = document.getElementById('diag-viewport');
const diagLoadedAt = document.getElementById('diag-loaded-at');

/**
 * Log message to on-screen box
 */
function logToScreen(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = `[${time}] ${msg}`;
    msgLogBox.appendChild(entry);
    msgLogBox.scrollTop = msgLogBox.scrollHeight;
}

/**
 * Update instruction display based on agent selection
 */
function updateAgentInstructions() {
    const selected = agentSelect.value;
    const agent = AGENT_TEMPLATES[selected] || AGENT_TEMPLATES.claude;
    
    // Combine general instructions with specific command
    const text = [
        `### Configuration for ${agent.name} ###`,
        agent.command,
        '',
        `Note: ${agent.note}`,
        '',
        '--- Full MCP Registration Details ---',
        currentInstructionText || 'Fetching full server instructions...'
    ].join('\n');

    instructionBox.textContent = text;
}

/**
 * Fetch full instructions from Helper
 */
async function fetchFullInstructions() {
    try {
        const res = await fetch('/api/webview-test/instructions');
        if (res.ok) {
            const data = await res.json();
            if (data.ok && data.instructions) {
                currentInstructionText = data.instructions;
                updateAgentInstructions();
            }
        }
    } catch (err) {
        console.warn('Could not fetch server instructions:', err);
    }
}

/**
 * Copy text to clipboard and provide visual feedback
 */
async function copyToClipboard(text) {
    let success = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            success = true;
        } catch (e) {
            console.warn('navigator.clipboard.writeText failed, falling back:', e);
        }
    }

    if (!success) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
        } catch (e) {
            console.error('execCommand copy failed:', e);
        }
    }

    if (success) {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied to Clipboard!';
        copyBtn.style.background = '#15803d';
        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
        }, 1800);
        logToScreen('Copied setup instructions to clipboard');
    } else {
        copyBtn.textContent = 'Copy Failed!';
        copyBtn.style.background = '#b91c1c';
        setTimeout(() => {
            copyBtn.textContent = 'Copy Setup Text';
            copyBtn.style.background = '';
        }, 1800);
        logToScreen('Clipboard copy failed');
    }
}

/**
 * Re-render stress list items
 */
function renderStressList() {
    stressList.innerHTML = '';
    for (let i = 1; i <= stressItemCount; i++) {
        const row = document.createElement('div');
        row.className = 'stress-row';
        row.innerHTML = `<span><strong>Step ${i}:</strong> Processing simulation check</span><span class="muted-text">Status: OK</span>`;
        stressList.appendChild(row);
    }
}

/**
 * Start live update polling (every 1.5 seconds)
 */
function startLivePolling() {
    setInterval(async () => {
        try {
            const res = await fetch('/api/webview-test/live');
            if (res.ok) {
                const data = await res.json();
                liveCounterEl.textContent = data.counter;
                liveUptimeEl.textContent = `${data.uptimeSeconds}s`;
                const now = new Date(data.timestamp);
                liveClockEl.textContent = now.toLocaleTimeString();
            }
        } catch (e) {
            liveCounterEl.textContent = 'Err';
        }
    }, 1500);
}

/**
 * Update diagnostic info
 */
function updateDiagnostics() {
    diagUa.textContent = navigator.userAgent;
    diagDpr.textContent = `${window.devicePixelRatio} (${Math.round(window.devicePixelRatio * 100)}%)`;
    diagViewport.textContent = `${window.innerWidth} x ${window.innerHeight} px`;
    diagLoadedAt.textContent = `${pageLoadTime.toLocaleTimeString()} (${pageLoadTime.toISOString()})`;
}

// Window resize listener to track viewport changes
window.addEventListener('resize', () => {
    diagViewport.textContent = `${window.innerWidth} x ${window.innerHeight} px`;
});

// Message bridge listener
window.addEventListener('message', (event) => {
    logToScreen(`Received from plugin: ${JSON.stringify(event.data)} (Origin: ${event.origin || 'unknown'})`);
});

// Event Listeners setup
agentSelect.addEventListener('change', updateAgentInstructions);

copyBtn.addEventListener('click', () => {
    copyToClipboard(instructionBox.textContent);
});

toggleTextBtn.addEventListener('click', () => {
    if (instructionBox.style.display === 'none') {
        instructionBox.style.display = 'block';
        toggleTextBtn.textContent = 'Hide text';
    } else {
        instructionBox.style.display = 'none';
        toggleTextBtn.textContent = 'Show text';
    }
});

addStepsBtn.addEventListener('click', () => {
    stressItemCount += 5;
    renderStressList();
    logToScreen(`Increased stress steps to ${stressItemCount}`);
});

removeStepsBtn.addEventListener('click', () => {
    if (stressItemCount > 2) {
        stressItemCount = Math.max(2, stressItemCount - 5);
        renderStressList();
        logToScreen(`Decreased stress steps to ${stressItemCount}`);
    }
});

pingBtn.addEventListener('click', () => {
    if (window.uxpHost && typeof window.uxpHost.postMessage === 'function') {
        const pingPayload = { type: 'ping', clientTime: Date.now() };
        window.uxpHost.postMessage(pingPayload);
        logToScreen(`Sent to plugin: ${JSON.stringify(pingPayload)}`);
    } else {
        logToScreen('ERROR: window.uxpHost not available (running outside UXP?)');
    }
});

closeBtn.addEventListener('click', () => {
    if (window.uxpHost && typeof window.uxpHost.postMessage === 'function') {
        logToScreen('Requesting plugin to close dialog via message bridge...');
        window.uxpHost.postMessage({ type: 'close-dialog' });
    } else {
        logToScreen('Cannot close: window.uxpHost not available');
    }
});

openViaBridgeBtn.addEventListener('click', () => {
    const targetUrl = 'https://developer.adobe.com/photoshop/uxp/';
    if (window.uxpHost && typeof window.uxpHost.postMessage === 'function') {
        window.uxpHost.postMessage({ type: 'open-external', url: targetUrl });
        logToScreen(`Sent open-external request for ${targetUrl}`);
    } else {
        logToScreen('window.uxpHost not available to open external link');
    }
});

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    if (window.uxpHost) {
        bridgeBadge.textContent = 'Bridge: Active';
        bridgeBadge.className = 'badge badge-bridge';
        logToScreen('window.uxpHost detected successfully');
    } else {
        bridgeBadge.textContent = 'Bridge: None';
        bridgeBadge.className = 'badge';
        logToScreen('window.uxpHost is NOT detected in window');
    }

    renderStressList();
    updateDiagnostics();
    startLivePolling();
    fetchFullInstructions();
});
