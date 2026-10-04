if (process.argv.includes('--royin-render-slidegen') || process.argv.includes('--royin-render-native-ppt')) {
  await import('./slidegen/render-command.js');
} else {
  await import('./index.js');
}

export {};
