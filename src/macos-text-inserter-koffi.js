// macOS Text Inserter using Core Graphics via koffi
// This module uses CGEventKeyboardSetUnicodeString to directly type Unicode characters
// without needing to go through the clipboard

// Platform check - only load on macOS
if (process.platform !== 'darwin') {
  module.exports = {
    insertText: async () => {
          return false;
    }
  };
  return;
}

const koffi = require('koffi');

// Load Core Graphics framework
const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');

// Define types
// CGEventRef is an opaque pointer
const CGEventRef = koffi.pointer('CGEventRef', koffi.opaque());
const CGEventSourceRef = koffi.pointer('CGEventSourceRef', koffi.opaque());

// Define CGEventTapLocation enum values
const kCGHIDEventTap = 0;           // Events go to HID system
const kCGSessionEventTap = 1;       // Events go to session
const kCGAnnotatedSessionEventTap = 2;

// Define functions
const CGEventCreateKeyboardEvent = cg.func('CGEventRef CGEventCreateKeyboardEvent(CGEventSourceRef source, uint16 virtualKey, bool keyDown)');
const CGEventKeyboardSetUnicodeString = cg.func('void CGEventKeyboardSetUnicodeString(CGEventRef event, unsigned long stringLength, const uint16 *unicodeString)');
const CGEventPost = cg.func('void CGEventPost(int tap, CGEventRef event)');
const CFRelease = cg.func('void CFRelease(void *cf)');

// Maximum characters per event (macOS limitation)
const MAX_CHARS_PER_EVENT = 20;

/**
 * Insert text by sending Unicode keyboard events
 * @param {string} text - The text to insert
 * @param {number} delayMs - Delay between character batches in milliseconds (default: 5)
 * @returns {Promise<boolean>} - Success status
 */
async function insertText(text, delayMs = 5) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input');
  }


  try {
    // Convert string to UTF-16 code units (what macOS expects)
    const utf16Units = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      utf16Units.push(code);
    }

    // Process in batches due to macOS limitation
    let offset = 0;
    while (offset < utf16Units.length) {
      const batchSize = Math.min(MAX_CHARS_PER_EVENT, utf16Units.length - offset);
      const batch = utf16Units.slice(offset, offset + batchSize);
      
      // Create a Uint16Array for the batch
      const unicodeBuffer = new Uint16Array(batch);
      
      // Create keyboard event (keycode 0, keyDown true)
      const keyDownEvent = CGEventCreateKeyboardEvent(null, 0, true);
      if (!keyDownEvent) {
        throw new Error('Failed to create keyboard event');
      }

      try {
        // Set the Unicode string on the event
        CGEventKeyboardSetUnicodeString(keyDownEvent, batchSize, unicodeBuffer);
        
        // Post the event
        CGEventPost(kCGHIDEventTap, keyDownEvent);
      } finally {
        // Release the event
        CFRelease(keyDownEvent);
      }

      offset += batchSize;

      // Small delay between batches to ensure events are processed
      if (offset < utf16Units.length && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return true;

  } catch (error) {
    console.error('Failed to insert text via macOS CGEvent:', error);
    throw error;
  }
}

/**
 * Test if the CGEvent API is working
 * @returns {boolean} - True if the API is available
 */
function isAvailable() {
  try {
    // Try to create a simple event to test if the API works
    const testEvent = CGEventCreateKeyboardEvent(null, 0, true);
    if (testEvent) {
      CFRelease(testEvent);
      return true;
    }
    return false;
  } catch (error) {
    console.error('CGEvent API not available:', error);
    return false;
  }
}

module.exports = {
  insertText,
  isAvailable
};
