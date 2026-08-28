/**
 * Déclarations MINIMALES des modules FreeSewing utilisés par TOILE.
 *
 * Les paquets FreeSewing sont livrés en `.mjs` source sans `.d.ts` : sans ces
 * déclarations, TypeScript infère les types de leurs centaines d'exports
 * (tous les modèles de mesures × toutes les tailles) et sature la mémoire
 * (heap OOM). On ne déclare ici que la surface réellement appelée — le
 * runtime, lui, charge les vrais modules inchangés.
 */
declare module '@freesewing/aaron' {
  export interface FsDesign {
    new (opts: {
      measurements: Record<string, number>;
      options?: Record<string, number | boolean>;
    }): {
      draft(): void;
      parts: Array<Record<string, unknown>>;
    };
  }
  export const Aaron: FsDesign;
}

declare module '@freesewing/brian' {
  export const Brian: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/teagan' {
  export const Teagan: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/sven' {
  export const Sven: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/titan' {
  export const Titan: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/sandy' {
  export const Sandy: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/diana' {
  export const Diana: import('@freesewing/aaron').FsDesign;
}

declare module '@freesewing/models' {
  /** Un modèle de mesures FreeSewing (nom de mesure → millimètres). */
  export const cisFemaleAdult38: Record<string, number>;
  export const cisMaleAdult42: Record<string, number>;
  const models: Record<string, Record<string, number>>;
  export default models;
}
