// @ts-check

const DECLARATION_BACKED_RESOLUTION_KINDS = new Set([
    "constructor",
    "inherited-member",
    "member",
    "option-property",
    "root-availability",
    "signature-compat",
    "transform-only",
    "type-property",
]);

const NON_DECLARATION_RESOLUTION_KINDS = new Set([
    "already-excluded-upstream",
    "behavioral",
    "not-modeled-upstream",
]);

/** @param {string} resolutionKind */
export function hasDeclarationSurface(resolutionKind) {
    if (DECLARATION_BACKED_RESOLUTION_KINDS.has(resolutionKind)) {
        return true;
    }

    if (NON_DECLARATION_RESOLUTION_KINDS.has(resolutionKind)) {
        return false;
    }

    throw new Error(`Unknown compat resolution kind: ${resolutionKind}`);
}
