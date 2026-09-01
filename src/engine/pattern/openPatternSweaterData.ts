/* eslint-disable */
// GÉNÉRÉ depuis « OPENPATTERN Navy Sweater » (openpattern.io), patron CC BY —
// © Open Pattern, utilisé avec attribution. Extraction :
// tools/extract_openpattern_dxf.py sur le DXF-AAMA fourni (calque 14 = ligne
// de COUTURE nette, RDP 1,5 mm, v=0 en haut). Taille UNIQUE M du lot.
// Bords-côtes du lot (Front/Back Hem 52×16, Sleeve Hem 22×14) écartés du
// 1er montage, comme les finitions d'Aaron et de Sven.
import type { UV } from './Draft';
import type { OpPieceData } from './openPatternData';

export interface OpSweaterData {
  front: OpPieceData;
  back: OpPieceData;
  sleeveWCm: number; // tour de manche à plat, à la tête (pièce entière)
  sleeveHCm: number; // longueur de manche (poignet nu, bord-côte non monté)
  /** Fuselage réel de la manche : largeur poignet / largeur tête. */
  sleeveCuffRatio: number;
  collarWCm: number; // bande de col Neck_2 à plat
  collarHCm: number;
}

export const OP_NAVY_SWEATER: OpSweaterData = {
  front: { wCm: 62.0, hCm: 67.51, outline: [[1.0,1.0],[1.0,0.4668],[0.9761,0.466],[0.9688,0.4399],[0.9662,0.0558],[0.613,0.0],[0.6096,0.0688],[0.6028,0.0918],[0.5915,0.1121],[0.5724,0.1321],[0.5468,0.1494],[0.5243,0.1581],[0.5,0.1606],[0.4757,0.1581],[0.4532,0.1494],[0.4276,0.1321],[0.4085,0.1121],[0.3972,0.0918],[0.3904,0.0688],[0.387,0.0],[0.0338,0.0558],[0.0312,0.4399],[0.0239,0.466],[0.0,0.4668],[0.0,1.0],[1.0,1.0]] as UV[] },
  back: { wCm: 62.0, hCm: 67.4, outline: [[0.4998,0.0545],[0.4676,0.0525],[0.4386,0.0433],[0.4117,0.028],[0.3759,0.0],[0.0339,0.0539],[0.0312,0.4387],[0.0238,0.4648],[0.0,0.4662],[0.0,1.0],[1.0,0.9999],[0.9998,0.466],[0.976,0.4646],[0.9686,0.4386],[0.9658,0.0537],[0.6238,0.0],[0.5879,0.0279],[0.561,0.0433],[0.532,0.0525],[0.4998,0.0545]] as UV[] },
  sleeveWCm: 60.0, sleeveHCm: 53.85,
  sleeveCuffRatio: 0.512,
  collarWCm: 46.0, collarHCm: 7.0,
};
