// Platform check - only load koffi on Windows
if (process.platform !== 'win32') {
  // Export empty function for non-Windows platforms
  module.exports = {
    insertText: async () => {
      return false;
    }
  };
  return;
}

const koffi = require('koffi');

// Define Windows API structures and constants
const INPUT_KEYBOARD = 1;
const KEYEVENTF_UNICODE = 0x0004;

// Correct Windows INPUT structure (union-based)
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'ushort',
    wScan: 'ushort', 
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
});

// Mouse input structure (for union completeness)
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
});

// Hardware input structure (for union completeness)  
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32',
    wParamL: 'ushort',
    wParamH: 'ushort'
});

// Union for input types
const INPUT_UNION = koffi.union('INPUT_UNION', {
    ki: KEYBDINPUT,
    mi: MOUSEINPUT,
    hi: HARDWAREINPUT
});

// Complete INPUT structure
const INPUT = koffi.struct('INPUT', {
    type: 'uint32',
    u: INPUT_UNION
});

// Load user32.dll and define functions
const user32 = koffi.load('user32.dll');
const SendInput = user32.func('uint32 SendInput(uint32 nInputs, INPUT *pInputs, int32 cbSize)');

// Load kernel32.dll for GetLastError
const kernel32 = koffi.load('kernel32.dll');
const GetLastError = kernel32.func('uint32 GetLastError()');

async function insertText(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Invalid text input');
    }

    try {
        // Convert text to array of Unicode code points
        const chars = Array.from(text);
        const inputs = [];
        
        // Create INPUT structure for each character
        for (const char of chars) {
            const unicode = char.codePointAt(0);
            
            const input = {
                type: INPUT_KEYBOARD,
                u: {
                    ki: {
                        wVk: 0,
                        wScan: unicode,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0
                    }
                }
            };
            
            inputs.push(input);
        }
        
        // Send all inputs at once
        const structSize = koffi.sizeof(INPUT);
        
        const result = SendInput(inputs.length, inputs, structSize);
        
        if (result !== inputs.length) {
            const lastError = GetLastError();
            console.error(`SendInput failed. Expected: ${inputs.length}, got: ${result}, LastError: ${lastError}`);
            
            // Try sending one character at a time as fallback
            let successCount = 0;
            for (const input of inputs) {
                try {
                    const singleResult = SendInput(1, [input], structSize);
                    if (singleResult === 1) {
                        successCount++;
                    } else {
                        console.error(`Single char failed, LastError: ${GetLastError()}`);
                    }
                    // Small delay between characters
                    await new Promise(resolve => setTimeout(resolve, 1));
                } catch (e) {
                    console.error('Single char exception:', e);
                }
            }
            
            if (successCount === 0) {
                throw new Error(`SendInput completely failed. LastError: ${lastError}`);
            }
            return true;
        }
        
        return true;
        
    } catch (error) {
        console.error('Failed to insert text via koffi:', error);
        throw error;
    }
}

module.exports = {
    insertText
};
