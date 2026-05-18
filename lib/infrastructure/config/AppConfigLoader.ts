import ConfigLoader from '@alembic/core/config';
import { PACKAGE_ROOT } from '../../shared/package-assets.js';

ConfigLoader._findPackageRoot = () => PACKAGE_ROOT;

export { ConfigLoader };
export default ConfigLoader;
