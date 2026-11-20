import { LIST_FIELD_ORDER, listFieldLabel } from '@trf/shared';
console.log('LIST_FIELD_ORDER length:', LIST_FIELD_ORDER.length);
LIST_FIELD_ORDER.forEach((field, i) => {
  console.log(`${i}: ${field.key} -> ${listFieldLabel(field)}`);
});
