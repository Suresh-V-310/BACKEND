import python from './definitions/python.js';
import c from './definitions/c.js';
import cpp from './definitions/cpp.js';
import java from './definitions/java.js';
import kotlin from './definitions/kotlin.js';
import csharp from './definitions/csharp.js';
import javascript from './definitions/javascript.js';
import typescript from './definitions/typescript.js';
import go from './definitions/go.js';
import rust from './definitions/rust.js';
import swift from './definitions/swift.js';
import ruby from './definitions/ruby.js';
import php from './definitions/php.js';
import r from './definitions/r.js';
import dart from './definitions/dart.js';
import scala from './definitions/scala.js';
import sql from './definitions/sql.js';
import matlab from './definitions/matlab.js';
import web from './definitions/web.js';
import { getRuntimeCapability, getRuntimeCapabilityList } from './runtimeCapabilities.js';

export const LANGUAGES = {
  python,
  c,
  cpp,
  java,
  kotlin,
  csharp,
  javascript,
  typescript,
  go,
  rust,
  swift,
  ruby,
  php,
  r,
  matlab,
  dart,
  scala,
  sql,
  web,
};

export const getLanguageByKey = (key) => LANGUAGES[key] || null;

export const getLanguageList = () =>
  Object.entries(LANGUAGES).map(([key, lang]) => ({
    key,
    name: lang.name,
    extension: lang.extension,
    monaco: lang.monaco,
    compilerOptions: lang.compilerOptions,
    supportedStandards: lang.supportedStandards,
    capabilities: getRuntimeCapability(key),
  }));

export const getLanguageCapabilities = () => getRuntimeCapabilityList();
