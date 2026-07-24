{
  description = "suxlib — SuxOS shared TypeScript library, pinned nodejs_22 devShell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    suxos-nix.url = "github:SuxOS/nix";
  };

  outputs = { self, nixpkgs, flake-utils, suxos-nix, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        # Level-2 devShell — composes on top of SuxOS/nix's shared Level-1 base
        # (box-pinned ucode + jq + shellcheck) and adds the TypeScript toolchain.
        # No prettier here: this repo has no prettier devDependency or config
        # (checked package.json — vitest/tsx/typescript only), so only nodejs_22 +
        # typescript are pinned.
        devShells.default = pkgs.mkShell {
          inputsFrom = [ suxos-nix.devShells.${system}.default ];
          packages = [ pkgs.nodejs_22 pkgs.typescript ];
          shellHook = ''
            echo "suxlib devShell"
          '';
        };
      });
}
