// Genera los borradores de CA-F-14, CA-F-15 y CA-F-35 a partir del texto de los
// formatos en PDF (Downloads/CA-F-xx Formato consentimiento informado ….pdf).
// Ejecutar: node templates/borradores/build-drafts.mjs  (desde API GATEWAY/)
import { writeFileSync } from 'node:fs';

const p = (text, extra = {}) => ({ type: 'paragraph', text, ...extra });
const h = (text, level = 2) => ({ type: 'heading', level, text });
const ul = (items) => ({ type: 'list', indent: 1, items });
const spacer = { type: 'spacer' };

// --- Autorización de datos personales (común a los tres formatos) ------------------
function dataProtection({ heading, address }) {
  return [
    h(heading, 1),
    p('La IPS ACR VITAL LABORAL SAS, identificada con NIT: 901066615 será la responsable del tratamiento y, en tal virtud, podrá recolectar, almacenar, y usar los datos personales de los pacientes como antecedentes personales y familiares Nombres, apellidos, edad, identificación, número de contacto, género, fecha de nacimiento, correo electrónico y otros que fuesen necesarios para el correcto diligenciamiento de la historia clínica y la realización de procedimientos asistenciales de Toma y procesamiento de muestras de laboratorio clínico.'),
    p('Manifiesto que me informaron que en caso de recolección de mi información sensible como la de mi estado de salud, tengo derecho a contestar o no las preguntas que me formulen y a entregar o no los datos solicitados.'),
    p('Entiendo que son datos sensibles aquellos que afectan la intimidad del Titular o cuyo uso indebido puede generar discriminación como el estado de salud.'),
    p('Manifiesto que me informaron que los datos sensibles que se recolectarán serán utilizados para el adecuado diligenciamiento de la historia clínica en la IPS ACR VITAL LABORAL SAS.'),
    h('Derechos del titular'),
    p('Sus derechos como titular del dato son los previstos en La Constitución y en la Ley 1581 de 2012, especialmente los siguientes:'),
    p('a) Acceder en forma gratuita a los datos proporcionados que hayan sido objeto de diagnóstico y tratamiento.', { indent: 1 }),
    p('b) Solicitar la actualización y rectificación de su información frente a datos parciales, inexactos, incompletos, fraccionados, que induzcan a error, o a aquellos cuyo tratamiento esté prohibido o no haya sido autorizado.', { indent: 1 }),
    p('c) Solicitar prueba de la autorización otorgada.', { indent: 1 }),
    p('d) Presentar ante la Superintendencia de Industria y Comercio (SIC) quejas por infracciones a lo dispuesto en la normatividad vigente.', { indent: 1 }),
    p('e) Revocar la autorización y/o solicitar la supresión del dato, a menos que exista un deber legal o contractual que haga imperativo conservar la información.', { indent: 1 }),
    p('f) Abstenerse de responder las preguntas sobre datos sensibles o sobre datos de las niñas y niños y adolescentes.', { indent: 1 }),
    p(`Estos derechos los podré ejercer a través de los canales o medios dispuestos por la IPS ACR VITAL LABORAL SAS, para la atención al público, el correo electrónico: acrvitallaboralsas@gmail.com y en las instalaciones de la IPS ${address} Tocancipá.`),
    p('Por todo lo anterior, he otorgado mi consentimiento a la IPS ACR VITAL LABORAL SAS, para que trate mi información personal de acuerdo con la Política de Tratamiento de Datos Personales.'),
    p('Manifiesto que la presente autorización me fue solicitada y puesta de presente antes de entregar mis datos y que la suscribo de forma libre y voluntaria una vez leída en su totalidad.'),
    spacer,
  ];
}

// --- Implicaciones del acto asistencial (CA-F-14 y CA-F-35) -------------------------
const implicaciones = [
  h('Implicaciones del acto asistencial'),
  p('Las implicaciones de un acto asistencial para la toma de muestras de laboratorio clínico pueden ser bastante significativas en términos de precisión de los resultados y la atención al paciente. Aquí se nombran algunas implicaciones importantes:'),
  ul([
    'Calidad de la muestra: La calidad de la muestra es crucial para obtener resultados precisos en los análisis de laboratorio. Un acto asistencial deficiente en la toma de muestras puede llevar a muestras contaminadas, deterioradas o mal etiquetadas, lo que puede afectar la validez de los resultados.',
    'Exactitud de los resultados: Una toma de muestra adecuada garantiza que los resultados de laboratorio reflejen con precisión la condición del paciente. Errores en la toma de muestras pueden llevar a resultados incorrectos, lo que a su vez puede afectar el diagnóstico y tratamiento del paciente.',
    'Seguridad del paciente: Un acto asistencial deficiente en la toma de muestras puede representar riesgos para la seguridad del paciente, como infecciones asociadas al cuidado de la salud si no se siguen las prácticas adecuadas de asepsia.',
    'Cumplimiento normativo: Existen normativas y estándares de calidad que regulan la toma de muestras de laboratorio clínico para garantizar la fiabilidad de los resultados. Un acto asistencial deficiente puede resultar en incumplimiento de estas normativas, lo que podría tener implicaciones legales y éticas.',
    'Experiencia del paciente: La experiencia del paciente también se ve afectada por la calidad de la toma de muestras. Un proceso bien gestionado, con personal capacitado y amable, puede mejorar la experiencia del paciente y su satisfacción con el servicio de laboratorio.',
  ]),
  p('En resumen, un acto asistencial adecuado en la toma de muestras de laboratorio clínico es fundamental para garantizar resultados precisos, seguridad del paciente, cumplimiento normativo y una experiencia positiva para el paciente.'),
  p('Una vez recibido el consentimiento informado se entrega archivo para que haga parte integral de la historia clínica del paciente.'),
];

// --- Acepto / No acepto (textos de los formatos) -----------------------------------
const ACEPTO =
  'Al firmar este documento declaro que he sido informado verbalmente, he leído y entendido la información correspondiente al procedimiento que se me va a realizar, pude formular las preguntas que tenía y encontré las respuestas que me permiten comprender los beneficios, riesgos, efectos. Declaro que soy mayor de edad y en uso pleno de mis facultades doy mi consentimiento y firmo.';
// En papel: "Yo ______ identificado como aparece al pie de mi firma…". En la app el
// nombre ya va en los datos del paciente del documento, así que el espacio en
// blanco se reemplaza por "el (la) abajo firmante".
const DESISTIMIENTO =
  'Yo, el (la) abajo firmante, identificado(a) como aparece al pie de mi firma, actuando en nombre propio o como representante legal del paciente, declaro que he sido informado(a) de la naturaleza y riesgos del procedimiento propuesto, manifiesto de forma libre y consciente mi DESISTIMIENTO para su realización, haciéndome responsable de las consecuencias que puedan derivarse de esta decisión.';

const decision = (procedimiento) => ({
  prompt: `¿Autoriza la realización ${procedimiento}?`,
  accept: { label: 'Acepto', blocks: [{ type: 'note', text: ACEPTO }] },
  decline: { label: 'No acepto', blocks: [h('Desistimiento'), { type: 'note', text: DESISTIMIENTO }] },
});

const common = {
  fields: [
    { key: 'nombre', label: 'Nombre del paciente', input: 'text', required: true, placeholder: 'Nombres y apellidos' },
    { key: 'cedula', label: 'Cédula del paciente', input: 'number', required: true, placeholder: 'Número de identificación' },
  ],
  // Orden de firma: primero el paciente, luego se entrega la tablet al profesional.
  signatures: [
    { key: 'patient', label: 'Firma del paciente', signer: 'patient', required: true },
    { key: 'professional', label: 'Firma del profesional', signer: 'professional', required: true },
  ],
  // Fila de cierre en el mismo orden que el formato en papel.
  footer: [
    { type: 'signature', key: 'professional' },
    { type: 'signature', key: 'patient' },
    { type: 'field', key: 'cedula' },
    { type: 'date', label: 'Fecha y hora' },
  ],
};

// Mismo número que el formato en papel cuando se puede. CA-F-14 1.0 ya está
// publicada (con un texto resumido) y lo publicado no se reemplaza: va como 1.1.
const VERSIONS = { 'CA-F-14': '1.1', 'CA-F-15': '1.0', 'CA-F-35': '1.0' };

const templates = {
  'CA-F-14': {
    code: 'CA-F-14',
    version: VERSIONS['CA-F-14'],
    title: 'Protección de datos y consentimiento informado — Toma de muestras',
    examType: 'TOMA_DE_MUESTRAS',
    effectiveDate: '2023-01-09',
    blocks: [
      ...dataProtection({
        heading: 'Autorización para el tratamiento de datos personales y consentimiento informado servicio de toma de muestras y laboratorio clínico',
        address: 'Calle 7 # 07-20',
      }),
      h('Consentimiento informado toma de muestras', 1),
      p('Señor usuario para la toma de muestras no se debe haber ingerido alimentos en las últimas 10 y preferiblemente 12 horas. No ingerir bebidas alcohólicas antes de 72 horas. Si no está en ayunas, comuníquelo al personal que le atiende. En algunos casos no es necesario estar en ayunas y podrán realizarse los análisis, en otros casos se registrará esos datos en el interrogatorio de pacientes para tenerlo en cuenta a la hora de interpretar los resultados. Una información incorrecta puede llevar a conclusiones erróneas sobre su estado de salud. Su colaboración es necesaria, usted es el primer interesado. El material utilizado para extraer la sangre es estéril y desechable por lo que no existe riesgo de infección.'),
      h('Objetivo procedimiento venopunción'),
      p('La Venopunción es un procedimiento frecuente en el laboratorio clínico para la obtención de muestras de suero, plasma y sangre total, los cuales son importantes para realizar análisis paraclínicos y cuyos reportes son de ayuda para el médico tratante en el momento de esclarecer diagnósticos, monitorizar afecciones de salud crónicos o en forma preventiva.'),
      h('Beneficios procedimiento de venopunción'),
      ul([
        'Extracción de sangre en la cantidad requerida con los cuidados asistenciales estipulados y por personal idóneo.',
        'Extracción de sangre segura bajo lineamientos e insumos de alta calidad.',
        'Obtener una parte representativa de sangre para realizar un estudio en el Laboratorio clínico.',
      ]),
      h('Posibles riesgos y/o complicaciones procedimiento venopunción'),
      ul([
        'Puede presentar una discreta hinchazón, estas molestias menores son poco frecuentes y no requieren tratamiento ni medicación específica.',
        'En el momento de la toma de muestra de sangre por Venopunción, sentirá un leve dolor tipo pinchazo.',
        'En casos esporádicos se podrían presentar complicaciones de este procedimiento, como hematoma y/o dolor leve, los cuales mejorarán espontáneamente o con medidas locales.',
        'En casos excepcionales, este dolor podría ser más severo y persistente o presentarse inflamación de la vena, infección o trombosis localizadas. Ocasionalmente en estos casos incluso se requerirá valoración médica para definir el manejo de acuerdo con la complicación presentada.',
        'En ocasiones puede ocurrir un difícil acceso a la vena lo que genera una nueva punción o un hematoma (acumulación de sangre causada por una ruptura de los vasos sanguíneos).',
        'Al momento de la toma de la muestra puede presentarse: náusea, mareo y sensación de debilidad y en algunos pacientes se puede generar lipotimia que es un desmayo que puede causar o no la pérdida del conocimiento y su recuperación es rápida y completa.',
      ]),
      ...implicaciones,
    ],
    decision: decision('de la toma de muestras'),
    ...common,
  },

  'CA-F-15': {
    code: 'CA-F-15',
    version: VERSIONS['CA-F-15'],
    title: 'Consentimiento informado — Frotis faríngeo',
    examType: 'FROTIS_FARINGEO',
    effectiveDate: '2024-01-09',
    blocks: [
      ...dataProtection({
        heading: 'Autorización para el tratamiento de datos personales y consentimiento',
        address: 'CRA 7 # 7-20',
      }),
      h('Consentimiento informado frotis faríngeo', 1),
      h('Objetivo procedimiento frotis'),
      p('Obtener una muestra de la faringe para posterior análisis clínico.'),
      p('Un frotis consiste en la extensión de una muestra de fluido corporal (humano) sobre un portaobjetos para su análisis clínico.'),
      h('Beneficios procedimiento frotis'),
      p('Sirve para:'),
      ul(['Identificar microorganismos que pueden causar una infección en la garganta.']),
      h('Posibles riesgos y/o complicaciones procedimiento frotis faríngeo'),
      ul(['Se puede producir molestias, náuseas y ganas de toser, pero solo dura unos cuantos segundos.']),
      h('Recomendaciones'),
      ul(['Adecuada posición del paciente.', 'Selección de insumos que cumplan con criterios de calidad.']),
      h('Alternativas al procedimiento de frotis faríngeo'),
      p('Cultivo faríngeo.'),
      h('Implicaciones del acto asistencial'),
      ul([
        // El PDF dice "para que pueda ser consultado por otras personas"; corregido a
        // "no pueda" con aprobación de la clínica (2026-10-06): era un error del formato.
        'La IPS ACR VITAL LABORAL SAS mantiene absoluta confidencialidad sobre sus resultados, queda una copia de los mismos en el sistema informático. El acceso a ese sistema está protegido para que no pueda ser consultado por otras personas.',
        'El procedimiento de Frotis Faríngeo se realiza de forma segura y es la opción comúnmente utilizada para posterior realización del procesamiento de la muestra, sin embargo, es un procedimiento seguro siempre y cuando se emplee la técnica correcta y los insumos seguros y confiables.',
        'El cumplimiento de las recomendaciones por parte de la profesional (Bacterióloga) antes, durante y después del procedimiento de Frotis Faríngeo son de gran importancia para acatar por parte del paciente y para lograr los resultados esperados.',
        'Es importante que la profesional (Bacterióloga) explique todos estos aspectos al paciente, responda a todas sus preguntas y se asegure que el paciente comprenda completamente el procedimiento de Frotis, beneficios, riesgos/complicaciones, alternativas antes de obtener el consentimiento informado para realizar el procedimiento. El paciente tiene el derecho de aceptar o rechazar la realización del Frotis Faríngeo después de recibir toda la información necesaria.',
      ]),
    ],
    decision: decision('del frotis faríngeo'),
    ...common,
    footer: [
      { type: 'signature', key: 'professional' },
      { type: 'signature', key: 'patient' },
      { type: 'field', key: 'cedula' },
      { type: 'date', label: 'Fecha' },
    ],
  },

  'CA-F-35': {
    code: 'CA-F-35',
    version: VERSIONS['CA-F-35'],
    title: 'Protección de datos y consentimiento informado — Test de drogas',
    examType: 'TEST_DE_DROGAS',
    effectiveDate: '2023-01-09',
    blocks: [
      ...dataProtection({
        heading: 'Autorización para el tratamiento de datos personales y consentimiento informado servicio de toma de muestras y laboratorio clínico',
        address: 'Calle 7 # 07-20',
      }),
      h('Consentimiento informado test de drogas', 1),
      p('El test de drogas es un examen realizado a partir de una muestra de orina para detectar en el organismo la presencia de sustancias psicoactivas. Es importante que usted como paciente informe al profesional de la salud sobre los medicamentos que ha consumido hoy y en los días previos a la toma de este examen y entienda que un resultado positivo de esta prueba, indica con alta probabilidad, de la presencia de ésta(s) sustancia(s) en el organismo.'),
      p('Existen varias pruebas de laboratorio diseñadas para este propósito las cuales se dividen básicamente en dos tipos: Presuntivas: que en caso de ser positivas indican una posible presencia de las sustancias psicoactivas y Confirmatorias. La prueba que se realizará inicialmente será de tipo presuntivo y en caso de salir positiva o indeterminada se realiza una prueba confirmatoria.'),
      h('Objetivo procedimiento'),
      p('A partir de una muestra de orina efectuar las pruebas necesarias para detectar en el organismo la presencia de sustancias psicoactivas, tales como marihuana, cocaína, bazuco, anfetaminas (éxtasis), benzodiacepinas (pepas), opiáceos (heroína) y sustancias similares o derivadas.'),
      h('Beneficios procedimiento'),
      ul(['Ninguna conocida para el paciente.']),
      h('Posibles riesgos y/o complicaciones procedimiento'),
      ul(['Por ser realizada a partir de una muestra de orina el procedimiento no presenta riesgos para la salud.']),
      ...implicaciones,
    ],
    decision: decision('del test de drogas'),
    ...common,
  },
};

for (const [code, t] of Object.entries(templates)) {
  // Destino: templates/<CÓDIGO>.json, la fuente que se publica con publish-template.mjs.
  const file = new URL(`../${code}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(t, null, 2) + '\n');
  console.log(`${code} v${t.version} → templates/${code}.json`);
}
