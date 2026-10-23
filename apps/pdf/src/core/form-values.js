import { PDFArray, PDFName } from 'pdf-lib';

export function defaultFieldValue(field) {
  const acro = field.acroField;
  const raw = acro.dict.context.lookup(acro.getInheritableAttribute(PDFName.of('DV')));
  return raw instanceof PDFArray
    ? raw
        .asArray()
        .map((item) => acro.dict.context.lookup(item)?.decodeText?.())
        .filter((item) => typeof item === 'string')
    : raw?.decodeText?.();
}

export function textValue(field) {
  if (field.acroField.V() !== undefined) return field.getText() || '';
  const value = defaultFieldValue(field);
  return typeof value === 'string' ? value : '';
}

export function choiceValues(field) {
  if (field.acroField.V() !== undefined) return field.getSelected();
  const value = defaultFieldValue(field);
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function choiceOptions(field) {
  // PDF.js resolves options through the field's parents. Give pdf-lib's option parser
  // the same read-only view, without copying or changing shared parent dictionaries.
  const source = Object.create(field.acroField);
  source.Opt = () => source.dict.context.lookup(source.getInheritableAttribute(PDFName.of('Opt')));
  return source.getOptions().map(({ value, display }) => ({
    value: value.decodeText(),
    label: (display || value).decodeText(),
  }));
}
