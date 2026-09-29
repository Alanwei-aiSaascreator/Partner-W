function checkedSlice(bytes, offset, size) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > bytes.length
  ) {
    throw new Error('PE icon resource is outside the file');
  }
  return bytes.subarray(offset, offset + size);
}

export function verifyExecutableIcon(executable, ico) {
  checkedSlice(ico, 0, 6);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Invalid source ICO header');
  const count = ico.readUInt16LE(4);
  if (count === 0) throw new Error('Source ICO has no images');
  const expected = Array.from({ length: count }, (_, index) => {
    const entry = checkedSlice(ico, 6 + index * 16, 16);
    return {
      metadata: entry.subarray(0, 12),
      bytes: checkedSlice(ico, entry.readUInt32LE(12), entry.readUInt32LE(8)),
    };
  });
  checkedSlice(executable, 0, 64);
  if (executable.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid PE DOS header');
  const peOffset = executable.readUInt32LE(0x3c);
  const header = checkedSlice(executable, peOffset, 24);
  if (header.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('Invalid PE signature');
  const sectionCount = header.readUInt16LE(6);
  const optionalSize = header.readUInt16LE(20);
  const optional = checkedSlice(executable, peOffset + 24, optionalSize);
  const magic = optional.readUInt16LE(0);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unsupported PE optional header');
  const resourceEntry = checkedSlice(optional, (magic === 0x20b ? 112 : 96) + 16, 8);
  const resourceRva = resourceEntry.readUInt32LE(0);
  const resourceSize = resourceEntry.readUInt32LE(4);
  if (!resourceRva || !resourceSize) throw new Error('PE has no icon resource directory');
  const sections = Array.from({ length: sectionCount }, (_, index) =>
    checkedSlice(executable, peOffset + 24 + optionalSize + index * 40, 40),
  );
  function rvaOffset(rva, size) {
    for (const section of sections) {
      const relative = rva - section.readUInt32LE(12);
      if (relative >= 0 && relative + size <= section.readUInt32LE(16)) {
        const offset = section.readUInt32LE(20) + relative;
        checkedSlice(executable, offset, size);
        return offset;
      }
    }
    throw new Error('PE icon resource RVA has no backed section');
  }
  const resourceOffset = rvaOffset(resourceRva, resourceSize);
  const resources = checkedSlice(executable, resourceOffset, resourceSize);
  const leaves = [];
  let visited = 0;
  function walk(offset, ids) {
    if (ids.length > 2 || ++visited > 4096) throw new Error('Invalid PE icon directory depth');
    const dir = checkedSlice(resources, offset, 16);
    const entries = dir.readUInt16LE(12) + dir.readUInt16LE(14);
    for (let index = 0; index < entries; index += 1) {
      const entry = checkedSlice(resources, offset + 16 + index * 8, 8);
      const id = entry.readUInt32LE(0);
      if (ids.length === 0 && id !== 3 && id !== 14) continue;
      const pointer = entry.readUInt32LE(4);
      const next = [...ids, id];
      if (pointer & 0x80000000) walk(pointer & 0x7fffffff, next);
      else {
        if (next.length !== 3) throw new Error('Invalid PE icon leaf');
        const data = checkedSlice(resources, pointer, 16);
        const size = data.readUInt32LE(4);
        leaves.push({ ids: next, bytes: checkedSlice(executable, rvaOffset(data.readUInt32LE(0), size), size) });
      }
    }
  }
  walk(0, []);
  const groups = leaves.filter(({ ids }) => ids[0] === 14);
  if (groups.length === 0) throw new Error('PE has no icon group');
  for (const group of groups) {
    checkedSlice(group.bytes, 0, 6 + count * 14);
    if (
      group.bytes.readUInt16LE(0) !== 0 ||
      group.bytes.readUInt16LE(2) !== 1 ||
      group.bytes.readUInt16LE(4) !== count
    ) {
      throw new Error('PE icon group does not match the source ICO');
    }
    expected.forEach((expectedImage, index) => {
      const entry = checkedSlice(group.bytes, 6 + index * 14, 14);
      const image = leaves.find(
        ({ ids }) => ids[0] === 3 && ids[1] === entry.readUInt16LE(12) && ids[2] === group.ids[2],
      );
      if (!entry.subarray(0, 12).equals(expectedImage.metadata) || !image?.bytes.equals(expectedImage.bytes)) {
        throw new Error(`PE icon image ${index + 1} does not match the source ICO`);
      }
    });
  }
  return { imageCount: count, groupCount: groups.length };
}
