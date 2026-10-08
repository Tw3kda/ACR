import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ConsentBlock } from '@/features/consent/types/consent';

const INDENT_STEP = 16;

function BlockView({ block }: { block: ConsentBlock }) {
  switch (block.type) {
    case 'heading':
      return <Text style={headingStyles[block.level ?? 1]}>{block.text}</Text>;

    case 'paragraph':
      return (
        <Text
          style={[
            styles.paragraph,
            { marginLeft: (block.indent ?? 0) * INDENT_STEP },
            block.emphasis === 'bold' && styles.bold,
            block.emphasis === 'italic' && styles.italic,
          ]}
        >
          {block.text}
        </Text>
      );

    case 'list':
      return (
        <View style={{ marginLeft: (block.indent ?? 0) * INDENT_STEP, gap: 6 }}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <Text style={styles.bullet}>{block.ordered ? `${index + 1}.` : '•'}</Text>
              <Text style={[styles.paragraph, styles.listText]}>{item}</Text>
            </View>
          ))}
        </View>
      );

    case 'note':
      return (
        <View style={styles.note}>
          <Text style={[styles.paragraph, styles.noteText]}>{block.text}</Text>
        </View>
      );

    case 'spacer':
      return <View style={styles.spacer} />;
  }
}

/**
 * The document's text as reading material on the fill screen.
 *
 * The masthead (logo · código · versión · fecha) is deliberately NOT here: it
 * belongs to the rendered document, which the patient sees in the preview and
 * in the PDF. Both of those go through documentHtml.ts, so the header has a
 * single definition instead of two that could drift apart.
 */
export function ConsentDocumentBody({ blocks }: { blocks: ConsentBlock[] }) {
  return (
    <View style={styles.body}>
      {blocks.map((block, index) => (
        <Fragment key={index}>
          <BlockView block={block} />
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  paragraph: { fontSize: 14, lineHeight: 21, color: '#1f2937' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },

  listItem: { flexDirection: 'row', gap: 8 },
  bullet: { fontSize: 14, lineHeight: 21, color: '#4e6870', minWidth: 18 },
  listText: { flex: 1 },

  note: {
    borderLeftWidth: 3,
    borderLeftColor: '#0e7a82',
    backgroundColor: '#f2f8f8',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 4,
  },
  noteText: { color: '#12212b' },

  spacer: { height: 8 },
});

const headingStyles = StyleSheet.create({
  1: { fontSize: 16, fontWeight: '700', color: '#12212b', marginTop: 8 },
  2: { fontSize: 14, fontWeight: '700', color: '#0b5f66', marginTop: 4 },
  3: { fontSize: 13, fontWeight: '600', color: '#4e6870' },
});
