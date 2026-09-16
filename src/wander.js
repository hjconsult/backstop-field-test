// In scope: src/** was declared.
module.exports = {
  inScope: () => 'in scope',
  // A second export, so this push is a real change rather than a CI poke.
  alsoInScope: () => 'still in scope',
};
