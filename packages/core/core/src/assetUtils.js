// @flow strict-local

import type {
  ASTGenerator,
  FilePath,
  GenerateOutput,
  Meta,
  PackageName,
  Stats,
  Symbol,
  SourceLocation,
  Transformer,
  QueryParameters,
} from '@parcel/types';
import type {
  Asset,
  RequestInvalidation,
  Dependency,
  Environment,
  ParcelOptions,
} from './types';
import type {ConfigOutput} from '@parcel/utils';

import {Readable} from 'stream';
import crypto from 'crypto';
import {PluginLogger} from '@parcel/logger';
import nullthrows from 'nullthrows';
import CommittedAsset from './CommittedAsset';
import UncommittedAsset from './UncommittedAsset';
import loadPlugin from './loadParcelPlugin';
import {Asset as PublicAsset} from './public/Asset';
import PluginOptions from './public/PluginOptions';
import {
  blobToStream,
  loadConfig,
  md5FromString,
  md5FromFilePath,
} from '@parcel/utils';
import {getEnvironmentHash} from './Environment';

type AssetOptions = {|
  id?: string,
  committed?: boolean,
  hash?: ?string,
  idBase?: ?string,
  filePath: FilePath,
  query?: QueryParameters,
  type: string,
  contentKey?: ?string,
  mapKey?: ?string,
  astKey?: ?string,
  astGenerator?: ?ASTGenerator,
  dependencies?: Map<string, Dependency>,
  isIsolated?: boolean,
  isInline?: boolean,
  isSplittable?: ?boolean,
  isSource: boolean,
  env: Environment,
  meta?: Meta,
  outputHash?: ?string,
  pipeline?: ?string,
  stats: Stats,
  symbols?: ?Map<Symbol, {|local: Symbol, loc: ?SourceLocation|}>,
  sideEffects?: boolean,
  uniqueKey?: ?string,
  plugin?: PackageName,
  configPath?: FilePath,
  configKeyPath?: string,
|};

export function createAsset(options: AssetOptions): Asset {
  let idBase = options.idBase != null ? options.idBase : options.filePath;
  let uniqueKey = options.uniqueKey || '';
  return {
    id:
      options.id != null
        ? options.id
        : md5FromString(
            idBase +
              options.type +
              getEnvironmentHash(options.env) +
              uniqueKey +
              (options.pipeline ?? ''),
          ),
    committed: options.committed ?? false,
    hash: options.hash,
    filePath: options.filePath,
    query: options.query || {},
    isIsolated: options.isIsolated ?? false,
    isInline: options.isInline ?? false,
    isSplittable: options.isSplittable,
    type: options.type,
    contentKey: options.contentKey,
    mapKey: options.mapKey,
    astKey: options.astKey,
    astGenerator: options.astGenerator,
    dependencies: options.dependencies || new Map(),
    isSource: options.isSource,
    outputHash: options.outputHash,
    pipeline: options.pipeline,
    env: options.env,
    meta: options.meta || {},
    stats: options.stats,
    symbols: options.symbols,
    sideEffects: options.sideEffects ?? true,
    uniqueKey: uniqueKey,
    plugin: options.plugin,
    configPath: options.configPath,
    configKeyPath: options.configKeyPath,
  };
}

const generateResults: WeakMap<Asset, Promise<GenerateOutput>> = new WeakMap();

export function generateFromAST(
  asset: CommittedAsset | UncommittedAsset,
): Promise<GenerateOutput> {
  let output = generateResults.get(asset.value);
  if (output == null) {
    output = _generateFromAST(asset);
    generateResults.set(asset.value, output);
  }
  return output;
}

async function _generateFromAST(asset: CommittedAsset | UncommittedAsset) {
  let ast = await asset.getAST();
  if (ast == null) {
    throw new Error('Asset has no AST');
  }

  let pluginName = nullthrows(asset.value.plugin);
  let {plugin} = await loadPlugin<Transformer>(
    asset.options.inputFS,
    asset.options.packageManager,
    pluginName,
    nullthrows(asset.value.configPath),
    nullthrows(asset.value.configKeyPath),
    asset.options.autoinstall,
  );
  if (!plugin.generate) {
    throw new Error(`${pluginName} does not have a generate method`);
  }

  let {content, map} = await plugin.generate({
    asset: new PublicAsset(asset),
    ast,
    options: new PluginOptions(asset.options),
    logger: new PluginLogger({origin: pluginName}),
  });

  let mapBuffer = map?.toBuffer();
  // Store the results in the cache so we can avoid generating again next time
  await Promise.all([
    asset.options.cache.setStream(
      nullthrows(asset.value.contentKey),
      blobToStream(content),
    ),
    mapBuffer != null &&
      asset.options.cache.setBlob(nullthrows(asset.value.mapKey), mapBuffer),
  ]);

  return {
    content:
      content instanceof Readable
        ? asset.options.cache.getStream(nullthrows(asset.value.contentKey))
        : content,
    map,
  };
}

export async function getConfig(
  asset: CommittedAsset | UncommittedAsset,
  filePaths: Array<FilePath>,
  options: ?{|
    packageKey?: string,
    parse?: boolean,
  |},
): Promise<ConfigOutput | null> {
  let packageKey = options?.packageKey;
  let parse = options && options.parse;

  if (packageKey != null) {
    let pkg = await asset.getPackage();
    if (pkg && pkg[packageKey]) {
      return {
        config: pkg[packageKey],
        // The package.json file was already registered by asset.getPackage() -> asset.getConfig()
        files: [],
      };
    }
  }

  let conf = await loadConfig(
    asset.options.inputFS,
    asset.value.filePath,
    filePaths,
    parse == null ? null : {parse},
  );
  if (!conf) {
    return null;
  }

  return conf;
}

export function getInvalidationId(invalidation: RequestInvalidation): string {
  switch (invalidation.type) {
    case 'file':
      return 'file:' + invalidation.filePath;
    case 'env':
      return 'env:' + invalidation.key;
    default:
      throw new Error('Unknown invalidation type: ' + invalidation.type);
  }
}

export async function getInvalidationHash(
  invalidations: Array<RequestInvalidation>,
  options: ParcelOptions,
): Promise<string> {
  let sortedInvalidations = invalidations
    .slice()
    .sort((a, b) => (getInvalidationId(a) < getInvalidationId(b) ? -1 : 1));

  let hash = crypto.createHash('md5');
  for (let invalidation of sortedInvalidations) {
    switch (invalidation.type) {
      case 'file':
        hash.update(
          await md5FromFilePath(options.inputFS, invalidation.filePath),
        );
        break;
      case 'env':
        hash.update(
          invalidation.key + ':' + (options.env[invalidation.key] || ''),
        );
        break;
    }
  }

  return hash.digest('hex');
}
