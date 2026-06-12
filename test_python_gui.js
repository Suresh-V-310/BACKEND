import { localRunCode } from './src/services/executionService.js';

async function runTest(name, payload) {
  console.log(`\n==================================================`);
  console.log(`Running Test: ${name}`);
  console.log(`Code to run:\n${payload.code.trim()}`);
  console.log(`--------------------------------------------------`);

  try {
    const start = Date.now();
    const result = await localRunCode({ language: 'python', ...payload });
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Finished in ${duration}s.`);
    console.log(`Success status: ${result.success}`);
    if (result.errorType) {
      console.log(`Error Type: ${result.errorType}`);
    }
    if (result.blockedLibrary) {
      console.log(`Blocked Library: ${result.blockedLibrary}`);
    }
    if (result.message) {
      console.log(`Message: ${result.message}`);
    }
    if (result.suggestion) {
      console.log(`Suggestions:\n${result.suggestion.map(s => `  - ${s}`).join('\n')}`);
    }
    if (result.stdout) {
      console.log(`STDOUT:\n${result.stdout.trim()}`);
    }
    if (result.stderr) {
      console.log(`STDERR:\n${result.stderr.trim()}`);
    }
    if (result.image) {
      console.log(`IMAGE base64 detected (length: ${result.image.length})`);
    }
  } catch (err) {
    console.error('Test execution failed with error:', err);
  }
}

async function startTests() {
  // 1. Valid Pandas / Numpy / Matplotlib Execution
  await runTest('Valid Plotting / Math Code (Allowed)', {
    code: `
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

print("Creating dataframe...")
df = pd.DataFrame(np.random.randn(5, 2), columns=['A', 'B'])
print(df)

print("Plotting...")
plt.plot(df['A'])
plt.title('Test Plot')
plt.show()
print("Plot successful!")
`
  });

  // 2. Tkinter Blocking (import tkinter)
  await runTest('Tkinter Block (import tkinter)', {
    code: `
import tkinter as tk
root = tk.Tk()
root.mainloop()
`
  });

  // 3. Tkinter Blocking (Tk() directly)
  await runTest('Tkinter Block (Tk() call)', {
    code: `
from tkinter import *
app = Tk()
`
  });

  // 4. Pygame Blocking (pygame.display.set_mode)
  await runTest('Pygame Block (pygame.display.set_mode)', {
    code: `
import pygame
pygame.display.set_mode((400, 300))
`
  });

  // 5. Pygame Blocking (pygame.init with GUI features)
  await runTest('Pygame Block (pygame.init with GUI)', {
    code: `
import pygame
pygame.init()
screen = pygame.display.set_mode((400, 300))
`
  });

  // 6. Pygame Clock Usage (pygame.init but NO GUI features - should NOT block)
  await runTest('Pygame Clock (Allowed, no GUI)', {
    code: `
import pygame
pygame.init()
clock = pygame.time.Clock()
print("Pygame initialized headlessly and clock retrieved!")
`
  });

  // 7. Turtle Blocking (turtle.Turtle)
  await runTest('Turtle Block (turtle.Turtle)', {
    code: `
import turtle
t = turtle.Turtle()
t.forward(100)
`
  });

  // 8. OpenCV GUI Blocking (cv2.imshow)
  await runTest('OpenCV GUI Block (cv2.imshow)', {
    code: `
import cv2
img = cv2.imread('test.png')
cv2.imshow('Image', img)
cv2.waitKey(0)
`
  });

  // 9. False Positive Avoidance (Comments and strings with library names)
  await runTest('False Positive Check (Comments & Strings - Allowed)', {
    code: `
# Do not use tkinter.Tk() in production
'''
We might want to write cv2.imshow('Win', img) or pygame.init()
'''
msg = "Welcome to python online compiler! We do not support Tk() or mainloop() here."
print(msg)
`
  });
}

startTests();
