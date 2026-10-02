/**
 * `vite/client` tipleri `tsconfig.json` `types` listesinde yok (dosya KORUMALI).
 * Bu yüzden CSS ve görsel içe aktarmaları burada beyan edilir; aksi halde
 * `tsc --noEmit` "Cannot find module './styles.css'" hatası verirdi.
 */
declare module "*.css";
declare module "*.svg";
declare module "*.png";
declare module "*.jpg";