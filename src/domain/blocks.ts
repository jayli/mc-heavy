export type RenderClass = 'opaque' | 'cutout' | 'translucent' | 'none';

export type BlockDefinition = Readonly<{
  id: number;
  key: string;
  solid: boolean;
  renderClass: RenderClass;
  orientation: boolean;
}>;

const definitions: readonly BlockDefinition[] = [
  { id: 0, key: 'air', solid: false, renderClass: 'none', orientation: false },
  { id: 1, key: 'stone', solid: true, renderClass: 'opaque', orientation: false },
  { id: 2, key: 'grass', solid: true, renderClass: 'opaque', orientation: false },
  { id: 3, key: 'water', solid: false, renderClass: 'translucent', orientation: false },
  { id: 4, key: 'sand', solid: true, renderClass: 'opaque', orientation: false },
  { id: 5, key: 'wood', solid: true, renderClass: 'opaque', orientation: true },
  { id: 6, key: 'leaves', solid: true, renderClass: 'cutout', orientation: false },
  { id: 7, key: 'glass', solid: true, renderClass: 'translucent', orientation: false },
];

const frozenDefinitions = definitions.map((definition) => Object.freeze(definition));

const byId = new Map(frozenDefinitions.map((definition) => [definition.id, definition]));
const byKey = new Map(frozenDefinitions.map((definition) => [definition.key, definition]));

export function blockByKey(key: string): BlockDefinition {
  const definition = byKey.get(key);
  if (!definition) throw new Error(`Unknown block key: ${key}`);
  return definition;
}

export function blockById(id: number): BlockDefinition {
  const definition = byId.get(id);
  if (!definition) throw new Error(`Unknown block id: ${id}`);
  return definition;
}

export type BlockRegistry = Readonly<{
  byId(id: number): BlockDefinition;
  byKey(key: string): BlockDefinition;
}>;

export const blockRegistry: BlockRegistry = Object.freeze({ byId: blockById, byKey: blockByKey });
