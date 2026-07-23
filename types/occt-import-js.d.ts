declare module "occt-import-js" {
  export interface OcctImportParameters {
    linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    linearDeflection?: number;
    angularDeflection?: number;
  }

  export interface OcctMesh {
    name?: string;
    attributes?: {
      position?: { array?: number[] };
      normal?: { array?: number[] };
    };
    index?: { array?: number[] };
  }

  export interface OcctImportResult {
    success: boolean;
    meshes?: OcctMesh[];
  }

  export interface OcctImporter {
    ReadStepFile(content: Uint8Array, parameters: OcctImportParameters | null): OcctImportResult;
  }

  export default function occtImportJs(): Promise<OcctImporter>;
}
