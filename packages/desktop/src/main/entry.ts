if (process.argv.includes('--royin-render-slidegen')) {
  await import('./slidegen/render-command.js');
} else {
  await import('./index.js');
}

export {};
