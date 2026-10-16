// Revisión de octubre de 2026 de los formatos de consentimiento.
//
//   - Nuevos formatos para pacientes menores de edad (NNA), transcritos de
//     Downloads/*_Menor_de_edad.docx: CA-F-14-M, CA-F-15-M, CA-F-35-M y LAB-F-VIH-M.
//   - Nuevo formato de VIH para adultos (LAB-F-VIH), derivado del de menores.
//   - Adultos CA-F-14, CA-F-15 y CA-F-35: nueva versión con lo que la revisión de
//     los formatos de menores corrigió y que aplica igual a adultos (redacción,
//     datos sensibles "bajo reserva", literal f, marco normativo, desistimiento
//     en nombre propio y motivo opcional).
//
// Escribe los JSON en templates/ y las copias de respaldo del APK en
// CONCENTIMIENTO_INFORMADO/src/features/consent/data/.
// Ejecutar desde API GATEWAY/:  node templates/borradores/build-2026-10.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '..');
const APP_DATA = path.resolve(HERE, '../../../CONCENTIMIENTO_INFORMADO/src/features/consent/data');

const EFFECTIVE = '2026-10-09';

const p = (text, extra = {}) => ({ type: 'paragraph', text, ...extra });
const h = (text, level = 2) => ({ type: 'heading', level, text });
const ul = (items) => ({ type: 'list', indent: 1, items });
const note = (text) => ({ type: 'note', text });
const spacer = { type: 'spacer' };

const ADDRESS_CALLE = 'Calle 7 # 07-20';
const ADDRESS_CRA = 'CRA 7 # 7-20'; // así figura en CA-F-15 (adulto y menor): confirmar con la IPS

// =====================================================================================
// Campos y firmas comunes
// =====================================================================================

// Tipo de decisión (Res. 309/2025): de la opción marcada depende quién firma.
const T_PROPIO_ACOMP = 'Consentimiento propio – adolescente de 14 años o más, acompañado por su representante legal';
const T_PROPIO_SOLO = 'Consentimiento propio – adolescente de 14 años o más, sin acompañante';
const T_SUSTITUTO = 'Consentimiento sustituto del representante legal, con asentimiento del NNA (menor de 14 años o sin habilidades para decidir)';
const T_MENOR_HABIL = 'Menor de 14 años con habilidades para decidir, acompañado por su representante legal (acto de bajo riesgo)';
const TIPOS = [T_PROPIO_ACOMP, T_PROPIO_SOLO, T_SUSTITUTO, T_MENOR_HABIL];
const REPRESENTANTE_FIRMA = [T_PROPIO_ACOMP, T_SUSTITUTO, T_MENOR_HABIL];
const PACIENTE_FIRMA = [T_PROPIO_ACOMP, T_PROPIO_SOLO, T_MENOR_HABIL];

const when = (values) => ({ key: 'tipo_decision', in: values });

function minorIdentification({ contact }) {
  return [
    { key: 'nombre', label: 'Nombres y apellidos del paciente (NNA)', input: 'text', required: true, placeholder: 'Nombres y apellidos' },
    { key: 'tipo_documento', label: 'Tipo de documento del paciente', input: 'select', required: true, options: ['Registro civil (RC)', 'Tarjeta de identidad (TI)', 'Otro'] },
    { key: 'documento', label: 'N° de documento del paciente', input: 'number', required: true, placeholder: 'Número de documento' },
    { key: 'fecha_nacimiento', label: 'Fecha de nacimiento', input: 'date', required: true },
    { key: 'edad', label: 'Edad (años cumplidos)', input: 'number', required: true },
    { key: 'grupo_edad', label: 'Grupo de edad', input: 'select', required: true, options: ['Menor de 14 años', 'De 14 a 17 años (adolescente)'] },
    { key: 'tipo_decision', label: 'Tipo de decisión', input: 'select', required: true, options: TIPOS },
    { key: 'asentimiento', label: 'Asentimiento del NNA', input: 'select', required: false, options: ['Sí asiente', 'No asiente'], requiredWhen: when([T_SUSTITUTO]) },
    { key: 'representante_nombre', label: 'Representante legal o acudiente (nombres y apellidos)', input: 'text', required: false, requiredWhen: when(REPRESENTANTE_FIRMA) },
    { key: 'representante_tipo_documento', label: 'Tipo de documento del representante', input: 'select', required: false, options: ['Cédula de ciudadanía (CC)', 'Cédula de extranjería (CE)', 'Otro'], requiredWhen: when(REPRESENTANTE_FIRMA) },
    { key: 'representante_documento', label: 'N° de documento del representante', input: 'number', required: false, requiredWhen: when(REPRESENTANTE_FIRMA) },
    { key: 'parentesco', label: 'Parentesco o calidad del representante', input: 'select', required: false, options: ['Madre', 'Padre', 'Tutor / curador', 'Otro'], requiredWhen: when(REPRESENTANTE_FIRMA) },
    { key: 'telefono', label: 'Teléfono de contacto', input: 'number', required: true },
    ...(contact === 'correo' ? [{ key: 'correo', label: 'Correo electrónico', input: 'text', required: false }] : []),
  ];
}

const declineMinorFields = [
  { key: 'desiste_calidad', label: 'Desiste en calidad de', input: 'select', required: true, decision: 'decline', options: ['En nombre propio, como paciente adolescente de 14 años o más', 'Como representante legal del paciente menor de edad'] },
  { key: 'motivo_desistimiento', label: 'Motivo del desistimiento', input: 'text', required: false, decision: 'decline' },
];

const professionalFields = [
  { key: 'profesional_nombre', label: 'Nombre del profesional', input: 'text', required: false, prefill: 'professional.name', filledBy: 'professional' },
  { key: 'registro_profesional', label: 'Registro profesional', input: 'text', required: true, filledBy: 'professional' },
  { key: 'cargo', label: 'Cargo', input: 'text', required: true, filledBy: 'professional' },
];

const assessmentFields = [
  { key: 'valoracion_habilidades', label: 'Valoración de habilidades para la toma de decisiones (Res. 309/2025, num. 3.6)', input: 'select', multiple: true, required: false, filledBy: 'professional', options: ['Comunica una decisión', 'Comprende la información', 'Razona sobre riesgos, beneficios y alternativas', 'Juzga la decisión según sus valores'] },
  { key: 'conclusion_valoracion', label: 'Conclusión de la valoración', input: 'select', required: true, filledBy: 'professional', options: ['Puede asumir la decisión', 'Requiere consentimiento sustituto del representante legal'] },
];

function minorSignatures({ professionalLabel, witness = false }) {
  return [
    { key: 'patient', label: 'Firma o huella del paciente (NNA)', signer: 'patient', required: false, requiredWhen: when(PACIENTE_FIRMA) },
    { key: 'representative', label: 'Firma del representante legal o acudiente', signer: 'patient', required: false, requiredWhen: when(REPRESENTANTE_FIRMA) },
    ...(witness ? [{ key: 'witness', label: 'Firma del testigo (opcional)', signer: 'patient', required: false }] : []),
    { key: 'professional', label: professionalLabel, signer: 'professional', required: true },
  ];
}

const minorFooter = (witness = false) => [
  { type: 'signature', key: 'patient' },
  { type: 'signature', key: 'representative' },
  ...(witness ? [{ type: 'signature', key: 'witness' }] : []),
  { type: 'signature', key: 'professional' },
  { type: 'date', label: 'Fecha y hora' },
];

// =====================================================================================
// Textos comunes de los formatos de menores
// =====================================================================================

function dataProtectionMinor({ heading, address }) {
  return [
    h(heading, 1),
    p('La IPS ACR VITAL LABORAL SAS, identificada con NIT: 901066615, será la responsable del tratamiento y, en tal virtud, podrá recolectar, almacenar y usar los datos personales del paciente menor de edad, como antecedentes personales y familiares, nombres, apellidos, edad, identificación, número de contacto, género, fecha de nacimiento, correo electrónico y otros que fuesen necesarios para el correcto diligenciamiento de la historia clínica y la realización del procedimiento asistencial de toma y procesamiento de muestras de laboratorio clínico.'),
    p('Por tratarse de datos de un niño, niña o adolescente (NNA), su tratamiento solo se realizará cuando responda y respete su interés superior y asegure el respeto de sus derechos fundamentales (artículo 7 de la Ley 1581 de 2012 y artículo 2.2.2.25.2.9 del Decreto 1074 de 2015). La autorización la otorga el representante legal del NNA, previo ejercicio del derecho del menor a ser escuchado; su opinión se valora teniendo en cuenta su madurez, autonomía y capacidad para entender el asunto.'),
    p('Manifestamos que nos informaron que, en caso de recolección de información sensible, como la relativa al estado de salud del NNA, existe el derecho a contestar o no las preguntas que se formulen y a entregar o no los datos solicitados. Entendemos que son datos sensibles aquellos que afectan la intimidad del titular o cuyo uso indebido puede generar discriminación, como el estado de salud, y que serán utilizados únicamente para el adecuado diligenciamiento de la historia clínica en la IPS ACR VITAL LABORAL SAS, bajo reserva.'),
    h('Derechos del titular'),
    p('Los derechos del NNA como titular del dato, que podrá ejercer directamente según su madurez o a través de su representante legal, son los previstos en la Constitución y en la Ley 1581 de 2012, especialmente los siguientes:'),
    ...rights(),
    p(`Estos derechos se podrán ejercer a través de los canales o medios dispuestos por la IPS ACR VITAL LABORAL SAS para la atención al público, el correo electrónico: acrvitallaboralsas@gmail.com y en las instalaciones de la IPS ${address}, Tocancipá.`),
    p('Por todo lo anterior, otorgamos nuestra autorización a la IPS ACR VITAL LABORAL SAS para que trate la información personal del NNA de acuerdo con la Política de Tratamiento de Datos Personales. Manifestamos que la presente autorización nos fue solicitada y puesta de presente antes de entregar los datos y que la suscribimos de forma libre y voluntaria una vez leída en su totalidad.'),
    spacer,
  ];
}

function rights() {
  return [
    'a) Acceder en forma gratuita a los datos proporcionados que hayan sido objeto de diagnóstico y tratamiento.',
    'b) Solicitar la actualización y rectificación de su información frente a datos parciales, inexactos, incompletos, fraccionados, que induzcan a error, o a aquellos cuyo tratamiento esté prohibido o no haya sido autorizado.',
    'c) Solicitar prueba de la autorización otorgada.',
    'd) Presentar ante la Superintendencia de Industria y Comercio (SIC) quejas por infracciones a lo dispuesto en la normatividad vigente.',
    'e) Revocar la autorización y/o solicitar la supresión del dato, a menos que exista un deber legal o contractual que haga imperativo conservar la información.',
    'f) Abstenerse de responder las preguntas sobre datos sensibles o sobre datos de los niños, niñas y adolescentes.',
  ].map((text) => p(text, { indent: 1 }));
}

function autonomy(classification) {
  return [
    h('Decisiones en salud del paciente menor de edad (autonomía progresiva)'),
    p('De acuerdo con la Resolución 309 de 2025 del Ministerio de Salud y Protección Social y la jurisprudencia de la Corte Constitucional (Sentencia C-246 de 2017), los niños, niñas y adolescentes ejercen su autonomía de forma progresiva, según su edad, madurez y el nivel de riesgo del procedimiento:'),
    ul([
      'Adolescente de 14 años o más: otorga su propio consentimiento informado, que tiene validez legal. Puede firmarlo sin la presencia de un adulto, según el nivel de riesgo del procedimiento y la valoración de sus habilidades para decidir. Si rechaza de forma informada un procedimiento que no es urgente, su decisión será respetada.',
      'Menor de 14 años: recibe información clara y acorde con su desarrollo y expresa su asentimiento, que se registra en la historia clínica. Su representante legal otorga el consentimiento sustituto, que siempre debe atender al interés superior del menor. Si el NNA no acepta un procedimiento que no es urgente, no se le obligará; se buscará su comprensión y aceptación sin coerción ni manipulación.',
      classification,
    ]),
    p('El tipo de decisión se registra en los datos de este documento y la valoración de las habilidades para decidir la registra el profesional (Res. 309/2025, num. 3.6).'),
  ];
}

const implicationsMinor = [
  h('Implicaciones del acto asistencial'),
  p('Las implicaciones de un acto asistencial para la toma de muestras de laboratorio clínico pueden ser bastante significativas en términos de precisión de los resultados y la atención al paciente. Aquí se nombran algunas implicaciones importantes:'),
  ul([
    'Calidad de la muestra: la calidad de la muestra es crucial para obtener resultados precisos en los análisis de laboratorio. Un acto asistencial deficiente en la toma de muestras puede llevar a muestras contaminadas, deterioradas o mal etiquetadas, lo que puede afectar la validez de los resultados.',
    'Exactitud de los resultados: una toma de muestra adecuada garantiza que los resultados de laboratorio reflejen con precisión la condición del paciente. Errores en la toma de muestras pueden llevar a resultados incorrectos, lo que a su vez puede afectar el diagnóstico y tratamiento del paciente.',
    'Seguridad del paciente: un acto asistencial deficiente en la toma de muestras puede representar riesgos para la seguridad del paciente, como infecciones asociadas al cuidado de la salud si no se siguen las prácticas adecuadas de asepsia.',
    'Cumplimiento normativo: existen normativas y estándares de calidad que regulan la toma de muestras de laboratorio clínico para garantizar la fiabilidad de los resultados. Un acto asistencial deficiente puede resultar en incumplimiento de estas normativas, lo que podría tener implicaciones legales y éticas.',
    'Experiencia del paciente: la experiencia del paciente también se ve afectada por la calidad de la toma de muestras. Un proceso bien gestionado, con personal capacitado en la atención de niños, niñas y adolescentes, trato amable y acompañamiento de su representante legal o persona de confianza, mejora la experiencia del paciente y su satisfacción con el servicio de laboratorio.',
  ]),
  p('En resumen, un acto asistencial adecuado en la toma de muestras de laboratorio clínico es fundamental para garantizar resultados precisos, seguridad del paciente, cumplimiento normativo y una experiencia positiva para el paciente. Una vez recibido el consentimiento informado, se archiva para que haga parte integral de la historia clínica del paciente.'),
];

const MARCO_MENORES = 'Marco normativo: Constitución Política, art. 44; Ley 1098 de 2006 – Código de la Infancia y la Adolescencia (arts. 8 y 26); Ley 1581 de 2012 y Decreto 1074 de 2015 (datos personales de NNA); Resolución 309 de 2025 del Ministerio de Salud y Protección Social; Sentencia C-246 de 2017 de la Corte Constitucional.';

const DECLARACION_MENOR = 'Al firmar este documento declaramos que el paciente menor de edad y, cuando aplica, su representante legal, hemos sido informados verbalmente, en un lenguaje claro y acorde con la edad y madurez del NNA; hemos leído y entendido la información correspondiente al procedimiento que se va a realizar; pudimos formular las preguntas que teníamos y encontramos las respuestas que nos permiten comprender sus beneficios, riesgos y efectos. En consecuencia, se otorga el consentimiento o asentimiento según lo marcado y firmamos.';

const minorDecision = (prompt) => ({
  prompt,
  accept: { label: 'Acepto', blocks: [note(DECLARACION_MENOR)] },
  decline: {
    label: 'No acepto',
    blocks: [
      h('Desistimiento'),
      note('Yo, quien firma este documento, identificado(a) como aparece al pie de mi firma y actuando en la calidad indicada en el campo «Desiste en calidad de», declaro que he sido informado(a) de la naturaleza y riesgos del procedimiento propuesto y manifiesto de forma libre y consciente mi DESISTIMIENTO para su realización, haciéndome responsable de las consecuencias que puedan derivarse de esta decisión.'),
      p('Nota: si el NNA con habilidades para decidir rechaza de forma informada un procedimiento no urgente, su decisión se respeta aunque el representante legal lo autorice (Res. 309/2025, num. 7.4). Si el NNA sin habilidades para decidir no asiente, no se le obligará y se buscará su comprensión sin coerción (num. 7.1). Si es el representante legal quien desiste y el procedimiento es necesario para la salud del NNA, el profesional lo registrará en la historia clínica y orientará la decisión conforme al interés superior del menor.'),
    ],
  },
});

// =====================================================================================
// Menores: CA-F-14-M, CA-F-15-M, CA-F-35-M
// =====================================================================================

const caF14M = {
  code: 'CA-F-14-M',
  version: '1.0',
  title: 'Protección de datos y consentimiento informado — Toma de muestras (menor de edad)',
  examType: 'TOMA_DE_MUESTRAS',
  audience: 'minor',
  effectiveDate: EFFECTIVE,
  blocks: [
    ...dataProtectionMinor({ heading: 'Autorización para el tratamiento de datos personales de niños, niñas y adolescentes y consentimiento informado – servicio de toma de muestras y laboratorio clínico', address: ADDRESS_CALLE }),
    h('Consentimiento informado toma de muestras – paciente menor de edad', 1),
    p('Señor(a) padre, madre o representante legal y paciente: para la toma de muestras no se deben haber ingerido alimentos en las últimas 10 y preferiblemente 12 horas; en niños y niñas, el personal le indicará el tiempo de ayuno adecuado según la edad y el examen solicitado. No ingerir bebidas alcohólicas en las 72 horas previas. Si el paciente no está en ayunas, comuníquelo al personal que lo atiende. En algunos casos no es necesario estar en ayunas y podrán realizarse los análisis; en otros casos se registrarán esos datos en el interrogatorio para tenerlos en cuenta a la hora de interpretar los resultados. Una información incorrecta puede llevar a conclusiones erróneas sobre el estado de salud del paciente; su colaboración es necesaria. El material utilizado para extraer la sangre es estéril y desechable, por lo que no existe riesgo de infección por el material.'),
    ...autonomy('Clasificación de este procedimiento: la toma de muestra de sangre por venopunción es un acto de bajo riesgo (beneficio claro para la salud con riesgo mínimo – Res. 309/2025, num. 3.1.1). En actos de bajo riesgo el NNA puede asumir la decisión según su nivel de desarrollo (num. 4.3); en todo caso se dejará registro de su consentimiento o asentimiento.'),
    h('Objetivo procedimiento venopunción'),
    p('La venopunción es un procedimiento frecuente en el laboratorio clínico para la obtención de muestras de suero, plasma y sangre total, las cuales son importantes para realizar análisis paraclínicos y cuyos reportes son de ayuda para el médico tratante en el momento de esclarecer diagnósticos, monitorizar afecciones de salud crónicas o en forma preventiva.'),
    h('Beneficios procedimiento de venopunción'),
    ul([
      'Extracción de sangre en la cantidad requerida según la edad y el peso del paciente, con los cuidados asistenciales estipulados y por personal idóneo.',
      'Extracción de sangre segura bajo lineamientos e insumos de alta calidad, de calibre adecuado para niños, niñas y adolescentes.',
      'Obtener una parte representativa de sangre para realizar un estudio en el laboratorio clínico.',
    ]),
    h('Posibles riesgos y/o complicaciones procedimiento venopunción'),
    ul([
      'Puede presentarse una discreta hinchazón; estas molestias menores son poco frecuentes y no requieren tratamiento ni medicación específica.',
      'En el momento de la toma de muestra de sangre por venopunción sentirá un leve dolor tipo pinchazo.',
      'En casos esporádicos se podrían presentar complicaciones como hematoma y/o dolor leve, los cuales mejorarán espontáneamente o con medidas locales.',
      'En casos excepcionales, este dolor podría ser más severo y persistente o presentarse inflamación de la vena, infección o trombosis localizadas. Ocasionalmente, en estos casos se requerirá valoración médica para definir el manejo de acuerdo con la complicación presentada.',
      'En ocasiones puede ocurrir un difícil acceso a la vena (más frecuente en niños pequeños), lo que genera una nueva punción o un hematoma (acumulación de sangre causada por una ruptura de los vasos sanguíneos).',
      'Al momento de la toma de la muestra puede presentarse náusea, mareo y sensación de debilidad, y en algunos pacientes se puede generar lipotimia, que es un desmayo que puede causar o no la pérdida del conocimiento y cuya recuperación es rápida y completa.',
      'En niños y niñas el representante legal o acompañante podrá estar presente y ayudar a mantener una posición cómoda y segura del brazo. En procedimientos no urgentes no se utilizará la fuerza para realizar la toma.',
    ]),
    ...implicationsMinor,
    p(MARCO_MENORES, { emphasis: 'italic' }),
  ],
  fields: [...minorIdentification({ contact: 'correo' }), ...declineMinorFields, ...assessmentFields, ...professionalFields],
  signatures: minorSignatures({ professionalLabel: 'Firma del profesional que realiza el procedimiento' }),
  footer: minorFooter(),
  decision: minorDecision('¿Se autoriza la realización de la toma de muestras?'),
};

const caF15M = {
  code: 'CA-F-15-M',
  version: '1.0',
  title: 'Consentimiento informado — Frotis faríngeo (menor de edad)',
  examType: 'FROTIS_FARINGEO',
  audience: 'minor',
  effectiveDate: EFFECTIVE,
  blocks: [
    ...dataProtectionMinor({ heading: 'Autorización para el tratamiento de datos personales de niños, niñas y adolescentes y consentimiento', address: ADDRESS_CRA }),
    h('Consentimiento informado frotis faríngeo – paciente menor de edad', 1),
    ...autonomy('Clasificación de este procedimiento: la toma de frotis faríngeo es un acto de bajo riesgo (beneficio claro para la salud con riesgo mínimo – Res. 309/2025, num. 3.1.1). En actos de bajo riesgo el NNA puede asumir la decisión según su nivel de desarrollo (num. 4.3); en todo caso se dejará registro de su consentimiento o asentimiento.'),
    h('Objetivo procedimiento frotis'),
    p('Obtener una muestra de la faringe para posterior análisis clínico. Un frotis consiste en la extensión de una muestra de fluido corporal (humano) sobre un portaobjetos para su análisis clínico.'),
    h('Beneficios procedimiento frotis'),
    p('Sirve para:'),
    ul(['Identificar microorganismos que pueden causar una infección en la garganta.']),
    h('Posibles riesgos y/o complicaciones procedimiento frotis faríngeo'),
    ul([
      'Se pueden producir molestias, náuseas y ganas de toser, pero solo duran unos cuantos segundos.',
      'En niños y niñas pequeños, el movimiento brusco de la cabeza durante la toma puede causar molestia adicional; por ello el representante legal o acompañante podrá ayudar a mantener una posición cómoda y segura, sin uso de la fuerza en procedimientos no urgentes.',
    ]),
    h('Recomendaciones'),
    ul([
      'Adecuada posición del paciente, acorde con su edad (sentado; en niños pequeños, en el regazo del acompañante).',
      'Selección de insumos que cumplan con criterios de calidad.',
      'Explicar al NNA, antes de iniciar y en lenguaje sencillo, en qué consiste el procedimiento y cuánto dura.',
    ]),
    h('Alternativas al procedimiento de frotis faríngeo'),
    p('Cultivo faríngeo.'),
    h('Implicaciones del acto asistencial'),
    ul([
      'La IPS ACR VITAL LABORAL SAS mantiene absoluta confidencialidad sobre los resultados; queda una copia de los mismos en el sistema informático, cuyo acceso está protegido para que no pueda ser consultado por personas no autorizadas.',
      'El procedimiento de frotis faríngeo es la opción comúnmente utilizada para el posterior procesamiento de la muestra, y es un procedimiento seguro siempre y cuando se emplee la técnica correcta y los insumos seguros y confiables.',
      'El cumplimiento de las recomendaciones dadas por la profesional (bacterióloga) antes, durante y después del procedimiento de frotis faríngeo es de gran importancia para lograr los resultados esperados.',
      'Es importante que la profesional (bacterióloga) explique todos estos aspectos al paciente y a su representante legal en un lenguaje acorde con la edad del NNA, responda todas sus preguntas y se asegure de que comprendan completamente el procedimiento de frotis, sus beneficios, riesgos/complicaciones y alternativas antes de obtener el consentimiento o asentimiento. El adolescente de 14 años o más tiene derecho a aceptar o rechazar la realización del frotis faríngeo después de recibir toda la información necesaria; en menores de 14 años se tendrá en cuenta su asentimiento.',
    ]),
    p(MARCO_MENORES, { emphasis: 'italic' }),
  ],
  fields: [...minorIdentification({ contact: 'correo' }), ...declineMinorFields, ...assessmentFields, ...professionalFields],
  signatures: minorSignatures({ professionalLabel: 'Firma del profesional que realiza el procedimiento' }),
  footer: minorFooter(),
  decision: minorDecision('¿Se autoriza la realización del frotis faríngeo?'),
};

const caF35M = {
  code: 'CA-F-35-M',
  version: '1.0',
  title: 'Protección de datos y consentimiento informado — Test de drogas (menor de edad)',
  examType: 'TEST_DE_DROGAS',
  audience: 'minor',
  effectiveDate: EFFECTIVE,
  blocks: [
    ...dataProtectionMinor({ heading: 'Autorización para el tratamiento de datos personales de niños, niñas y adolescentes y consentimiento informado – servicio de toma de muestras y laboratorio clínico', address: ADDRESS_CALLE }),
    h('Consentimiento informado test de drogas – paciente menor de edad', 1),
    p('El test de drogas es un examen realizado a partir de una muestra de orina para detectar en el organismo la presencia de sustancias psicoactivas. Es importante que el paciente, o su representante legal, informe al profesional de la salud sobre los medicamentos que ha consumido hoy y en los días previos a la toma de este examen, y entienda que un resultado positivo de esta prueba indica, con alta probabilidad, la presencia de esta(s) sustancia(s) en el organismo.'),
    p('Existen varias pruebas de laboratorio diseñadas para este propósito, las cuales se dividen básicamente en dos tipos: presuntivas, que en caso de ser positivas indican una posible presencia de las sustancias psicoactivas, y confirmatorias. La prueba que se realizará inicialmente será de tipo presuntivo y, en caso de salir positiva o indeterminada, se realizará una prueba confirmatoria.'),
    ...autonomy('Clasificación de este procedimiento: el test de drogas en orina es un procedimiento de bajo riesgo físico, pero involucra información sensible del NNA. Por ello: (i) el adolescente de 14 años o más debe otorgar su propio consentimiento y puede negarse a la prueba; (ii) en menores de 14 años se requiere el asentimiento del NNA y el consentimiento sustituto de su representante legal; (iii) el resultado es confidencial, tiene fines exclusivamente de cuidado de la salud y no sancionatorios, y un resultado positivo se orientará a la ruta de atención integral en salud mental y consumo de sustancias psicoactivas.'),
    h('Objetivo procedimiento'),
    p('A partir de una muestra de orina, efectuar las pruebas necesarias para detectar en el organismo la presencia de sustancias psicoactivas, tales como marihuana, cocaína, bazuco, anfetaminas (éxtasis), benzodiacepinas (pepas), opiáceos (heroína) y sustancias similares o derivadas.'),
    h('Beneficios procedimiento'),
    ul(['Ninguno directo derivado de la toma de la muestra. Un resultado positivo permite orientar de manera oportuna la atención integral en salud del NNA.']),
    h('Posibles riesgos y/o complicaciones procedimiento'),
    ul([
      'Por ser realizada a partir de una muestra de orina, el procedimiento no presenta riesgos para la salud.',
      'La recolección de la muestra se realizará respetando la intimidad y el pudor del NNA; no se realizará observación directa de la recolección salvo indicación justificada y con su conocimiento previo.',
    ]),
    h('Confidencialidad y entrega de resultados'),
    p('El resultado hace parte de la historia clínica y está sujeto a reserva. Se entregará a quien se indique en el campo «Entrega del resultado»; al médico tratante o entidad que remite, solo con autorización expresa.'),
    ...implicationsMinor,
    p(MARCO_MENORES, { emphasis: 'italic' }),
  ],
  fields: [
    ...minorIdentification({ contact: 'correo' }),
    { key: 'entrega_resultado', label: 'Entrega del resultado', input: 'select', multiple: true, required: true, options: ['El paciente adolescente', 'El representante legal', 'El médico tratante o entidad que remite (con autorización expresa)'] },
    ...declineMinorFields,
    ...assessmentFields,
    ...professionalFields,
  ],
  signatures: minorSignatures({ professionalLabel: 'Firma del profesional que realiza el procedimiento' }),
  footer: minorFooter(),
  decision: minorDecision('¿Se autoriza la realización del test de drogas?'),
};

// =====================================================================================
// VIH: LAB-F-VIH-M (menores) y LAB-F-VIH (adultos)
// =====================================================================================

const PRUEBAS = ['Prueba presuntiva (prueba rápida / ELISA)', 'Prueba confirmatoria (según algoritmo diagnóstico vigente)'];
const INDICACIONES = ['Antecedentes de riesgo', 'Solicitud voluntaria', 'Accidente con riesgo biológico', 'Embarazo', 'Manifestaciones clínicas sugestivas de infección por VIH', 'Sospecha de violencia sexual'];

function hivInformation({ minor }) {
  const subject = minor ? 'el paciente' : 'el paciente';
  return [
    h('III. Información', 1),
    p(
      minor
        ? 'Quien firma, identificado(a) como aparece al pie de su firma y actuando en la calidad indicada en el campo «Actúa en calidad de», manifiesta por medio del presente documento, de manera expresa, libre y voluntaria, que el profesional que realiza la asesoría le ha explicado la necesidad de practicar las pruebas señaladas en el campo «Pruebas a realizar» para detectar infección por el virus de la inmunodeficiencia humana (VIH), por la indicación registrada, y que ha recibido información sobre los siguientes aspectos:'
        : 'Yo, identificado(a) como aparece al pie de mi firma, por medio del presente documento, de manera expresa, libre y voluntaria, manifiesto que el profesional que realiza la asesoría me ha explicado la necesidad de practicar las pruebas señaladas en el campo «Pruebas a realizar» para detectar infección por el virus de la inmunodeficiencia humana (VIH), por la indicación registrada, y que he recibido información sobre los siguientes aspectos:'
    ),
    h('1. ¿Qué es el VIH y qué es el SIDA?', 3),
    p('El VIH es un virus que afecta el sistema inmunitario (las defensas del cuerpo), de tal manera que la persona se vuelve más propensa a enfermarse. El SIDA es la etapa avanzada de la infección cuando esta no recibe tratamiento.'),
    h('2. Propósito del examen y tipos de prueba', 3),
    p('La prueba presuntiva (prueba rápida o ELISA) se utiliza para precisar si una persona puede estar infectada con el VIH, mediante la detección en sangre de anticuerpos (defensas producidas por el organismo) contra ese virus. Si el resultado es reactivo, se requiere una prueba confirmatoria.'),
    h('3. Condiciones de riesgo para adquirir la infección', 3),
    p('Relaciones sexuales sin protección; compartir agujas o material cortopunzante contaminado (por ejemplo, para consumir drogas inyectables, tatuajes o perforaciones); contacto con sangre no segura; y transmisión de la madre al hijo durante el embarazo, el parto o la lactancia.'),
    h('4. Confiabilidad y limitaciones de la prueba', 3),
    p('La prueba es realizada por personal idóneo e incluye asesoría y acompañamiento. Existe un «periodo de ventana» en el que, a pesar de existir la infección, la prueba puede salir negativa; por ello, según el riesgo, puede indicarse repetirla.'),
    h('5. Procedimiento de la toma', 3),
    p('Antes de realizar la prueba se explica el procedimiento, que consiste en obtener una muestra de sangre: se limpia el área para eliminar las bacterias, se coloca el torniquete, se punza con una aguja y se extrae una pequeña muestra de sangre en un tubo (o una gota, en la prueba rápida). Luego se retira la aguja y se cubre el sitio de punción.'),
    h('6. Consecuencias en caso de no aceptar', 3),
    p(`Al no tomar la muestra no se sabrá si ${subject} tiene la infección por VIH; en caso de tenerla, se retrasaría su tratamiento y se mantendría el riesgo de transmisión a otras personas, incluido el hijo(a) en caso de embarazo.`),
    h('7. Riesgos de la toma de muestra', 3),
    p('Puede sentir molestia, ardor o dolor leve en el sitio de punción y, en algunos casos, quedar un morado (equimosis).'),
    h('8. Implicaciones y consecuencias de un resultado anormal', 3),
    p(`Si el resultado es reactivo, se realizará la prueba confirmatoria. Si esta es positiva, significa que existe infección por VIH y ${subject} será orientado para su atención y tratamiento a través de su EPS; si es negativa, no hay evidencia en este momento de la infección.`),
    h('IV. Beneficios', 1),
    ul([
      'Si hay infección, se puede dar tratamiento efectivo que retrasa el desarrollo de la enfermedad y se puede prevenir el contagio a otros. También permite tomar precauciones con la sangre y durante las relaciones sexuales, protegiéndose a sí mismo y a los demás. En caso de embarazo, el tratamiento previene la transmisión de la infección al hijo(a).',
      'Desventajas: la prueba puede generar miedo, estrés, angustia o ansiedad mientras se conoce el resultado; por ello se brinda asesoría antes y después de la prueba.',
    ]),
    h('V. Riesgos', 1),
    ul(['Algunas personas, cuando se les informa que tienen anticuerpos contra el VIH (resultado reactivo), pueden presentar fuertes reacciones emocionales, incluyendo ansiedad y depresión. También pueden ser objeto de discriminación o rechazo por otras personas e instituciones; por ello la IPS garantiza la confidencialidad del resultado y orienta hacia apoyo psicosocial cuando se requiera.']),
    h('VI. Alternativa', 1),
    ul(['Ninguna.']),
    h('VII. Confidencialidad del resultado', 1),
    p('El paciente autoriza que el resultado sea conocido únicamente por quienes se indican en el campo «Resultado conocido por».'),
  ];
}

const hivDecision = (declaration) => ({
  prompt: '¿Autoriza la toma de muestras y la realización de las pruebas señaladas?',
  accept: {
    label: 'Autorizo',
    blocks: [
      h('VIII. Autorización'),
      note('Como resultado de la información recibida, manifiesto que AUTORIZO la toma de muestras y la realización de las pruebas señaladas en el presente documento.'),
      note(declaration),
    ],
  },
  decline: {
    label: 'No acepto',
    blocks: [
      h('IX. Disentimiento'),
      note('NO ACEPTO la realización del procedimiento descrito. Con este documento certifico que he sido informado(a) acerca de la importancia del procedimiento para la salud del paciente, sus beneficios y posibles riesgos; se me permitió aclarar dudas y conozco las posibles consecuencias de no aceptar su realización. A pesar de esto, no acepto el procedimiento.'),
      note(declaration),
    ],
  },
});

const hivTestFields = [
  { key: 'pruebas', label: 'Pruebas a realizar', input: 'select', multiple: true, required: true, options: PRUEBAS },
  { key: 'indicacion', label: 'Indicación de la solicitud', input: 'select', multiple: true, required: true, options: INDICACIONES },
];

const witnessFields = [
  { key: 'testigo_nombre', label: 'Nombre del testigo', input: 'text', required: false },
  { key: 'testigo_documento', label: 'Documento del testigo', input: 'number', required: false },
];

const hcField = { key: 'hc_numero', label: 'Historia clínica N°', input: 'text', required: false, filledBy: 'professional' };

const labFVihM = {
  code: 'LAB-F-VIH-M',
  version: '1.0',
  title: 'Consentimiento informado de virus de inmunodeficiencia humana (VIH) — Paciente menor de edad',
  examType: 'PRUEBA_VIH',
  audience: 'minor',
  effectiveDate: EFFECTIVE,
  blocks: [
    h('Macroproceso de prestación de servicios asistenciales · Proceso de apoyo diagnóstico · Subproceso de laboratorio clínico', 3),
    h('II. Prueba voluntaria y confidencial – servicio con protección especial', 1),
    p('La prueba de VIH es un servicio con protección especial para niños, niñas y adolescentes (Resolución 309 de 2025, numeral 9 del anexo técnico). Por ello:'),
    ul([
      'La prueba es voluntaria y confidencial; no se realizará sin el consentimiento del paciente.',
      'Adolescente de 14 años o más: decide de forma autónoma y no requiere autorización de sus padres o representante legal para realizarse la prueba.',
      'Menor de 14 años: puede solicitar la prueba y otorgar su consentimiento si cuenta con las habilidades para decidir; si no las tiene, se requiere el consentimiento sustituto del representante legal y el asentimiento del NNA.',
      'Confidencialidad del resultado: no se revelará a terceros, incluidos padres o representante legal, si el NNA no lo desea. El equipo de salud promoverá la comunicación con su familia o con una persona de confianza.',
      'Sospecha de violencia sexual: ante sospecha de violencia sexual (en especial intrafamiliar), la prueba puede realizarse sin el consentimiento del representante legal. En estos casos, y siempre que se trate de un menor de 14 años con antecedente de actividad sexual, se activará la ruta de atención integral a víctimas de violencia sexual de la IPS y la notificación obligatoria correspondiente.',
      'La prueba se acompaña de asesoría antes y después de su realización, en lenguaje claro y acorde con la edad del NNA.',
    ]),
    ...hivInformation({ minor: true }),
    p('El consentimiento informado es la manifestación voluntaria y consciente del paciente por la que autoriza un determinado procedimiento o tratamiento propuesto, con base en información comprensible, suficiente y veraz sobre su propósito, riesgos, molestias, efectos secundarios y consecuencias en caso de no aceptar. En el caso de niños, niñas y adolescentes, se otorga según su autonomía progresiva: consentimiento propio desde los 14 años, o asentimiento del NNA con consentimiento sustituto de su representante legal. En este caso, el procedimiento es una prueba de laboratorio para detectar la infección por VIH.'),
    p(`${MARCO_MENORES.replace(/\.$/, '')}; Ley 972 de 2005 (atención de la población con VIH/SIDA).`, { emphasis: 'italic' }),
  ],
  fields: [
    ...minorIdentification({ contact: 'none' }),
    { key: 'actua_en_calidad', label: 'Actúa en calidad de', input: 'select', required: true, options: ['En nombre propio, como paciente adolescente de 14 años o más', 'En nombre propio, como paciente menor de 14 años con habilidades para decidir', 'Como representante legal del paciente'] },
    ...hivTestFields,
    { key: 'resultado_conocido_por', label: 'Resultado conocido por', input: 'select', multiple: true, required: true, options: ['Únicamente el paciente', 'Su representante legal', 'Otra persona de confianza'] },
    { key: 'persona_confianza', label: 'Nombre de la persona de confianza', input: 'text', required: false, requiredWhen: { key: 'resultado_conocido_por', in: ['Otra persona de confianza'] } },
    ...witnessFields,
    hcField,
    ...assessmentFields,
    ...professionalFields,
  ],
  signatures: minorSignatures({ professionalLabel: 'Firma del profesional que realiza la asesoría', witness: true }),
  footer: minorFooter(true),
  decision: hivDecision(DECLARACION_MENOR),
};

const labFVih = {
  code: 'LAB-F-VIH',
  version: '1.0',
  title: 'Consentimiento informado de virus de inmunodeficiencia humana (VIH)',
  examType: 'PRUEBA_VIH',
  audience: 'adult',
  effectiveDate: EFFECTIVE,
  blocks: [
    h('Macroproceso de prestación de servicios asistenciales · Proceso de apoyo diagnóstico · Subproceso de laboratorio clínico', 3),
    h('II. Prueba voluntaria y confidencial', 1),
    ul([
      'La prueba es voluntaria y confidencial; no se realizará sin el consentimiento del paciente.',
      'Confidencialidad del resultado: no se revelará a terceros sin la autorización del paciente. El equipo de salud promoverá la comunicación con una persona de confianza si el paciente lo desea.',
      'Sospecha de violencia sexual: ante sospecha de violencia sexual, se activará la ruta de atención integral a víctimas de violencia sexual de la IPS y la notificación obligatoria correspondiente.',
      'La prueba se acompaña de asesoría antes y después de su realización, en lenguaje claro.',
    ]),
    ...hivInformation({ minor: false }),
    p('El consentimiento informado es la manifestación voluntaria y consciente del paciente por la que autoriza un determinado procedimiento o tratamiento propuesto, con base en información comprensible, suficiente y veraz sobre su propósito, riesgos, molestias, efectos secundarios y consecuencias en caso de no aceptar. En este caso, el procedimiento es una prueba de laboratorio para detectar la infección por VIH.'),
    p('Marco normativo: Ley 972 de 2005 (atención de la población con VIH/SIDA); Ley 1581 de 2012 y Decreto 1074 de 2015 (protección de datos personales).', { emphasis: 'italic' }),
  ],
  fields: [
    { key: 'nombre', label: 'Nombre del paciente', input: 'text', required: true, placeholder: 'Nombres y apellidos' },
    { key: 'cedula', label: 'Cédula del paciente', input: 'number', required: true, placeholder: 'Número de identificación' },
    { key: 'telefono', label: 'Teléfono de contacto', input: 'number', required: true },
    ...hivTestFields,
    { key: 'resultado_conocido_por', label: 'Resultado conocido por', input: 'select', multiple: true, required: true, options: ['Únicamente el paciente', 'Otra persona de confianza'] },
    { key: 'persona_confianza', label: 'Nombre de la persona de confianza', input: 'text', required: false, requiredWhen: { key: 'resultado_conocido_por', in: ['Otra persona de confianza'] } },
    ...witnessFields,
    { key: 'motivo_desistimiento', label: 'Motivo por el que no acepta', input: 'text', required: false, decision: 'decline' },
    hcField,
    ...professionalFields,
  ],
  signatures: [
    { key: 'patient', label: 'Firma del paciente', signer: 'patient', required: true },
    { key: 'witness', label: 'Firma del testigo (opcional)', signer: 'patient', required: false },
    { key: 'professional', label: 'Firma del profesional que realiza la asesoría', signer: 'professional', required: true },
  ],
  footer: [
    { type: 'signature', key: 'patient' },
    { type: 'signature', key: 'witness' },
    { type: 'signature', key: 'professional' },
    { type: 'date', label: 'Fecha y hora' },
  ],
  decision: hivDecision('Al firmar este documento declaro que he sido informado verbalmente, he leído y entendido la información correspondiente al procedimiento que se me va a realizar, pude formular las preguntas que tenía y encontré las respuestas que me permiten comprender los beneficios, riesgos y efectos. Declaro que soy mayor de edad y en uso pleno de mis facultades.'),
};

// =====================================================================================
// Adultos: nueva versión de CA-F-14, CA-F-15 y CA-F-35
// =====================================================================================

const MARCO_ADULTOS = 'Marco normativo: Ley 1581 de 2012 y Decreto 1074 de 2015 (protección de datos personales).';

/** Sustituye un texto exacto; si no está, el generador se detiene (el formato cambió). */
function replaceText(template, from, to) {
  let hits = 0;
  const swap = (text) => (text === from ? (hits++, to) : text);
  const walk = (blocks) =>
    blocks.map((b) => {
      if (b.type === 'list') return { ...b, items: b.items.map(swap) };
      if ('text' in b) return { ...b, text: swap(b.text) };
      return b;
    });
  template.blocks = walk(template.blocks);
  if (template.decision) {
    template.decision.accept.blocks = walk(template.decision.accept.blocks);
    template.decision.decline.blocks = walk(template.decision.decline.blocks);
  }
  if (hits === 0) throw new Error(`${template.code}: no se encontró el texto «${from.slice(0, 70)}…»`);
}

/** Lo que la revisión de menores corrigió en el texto común a los tres formatos de adultos. */
function updateAdultCommon(t, address) {
  replaceText(t, 'La IPS ACR VITAL LABORAL SAS, identificada con NIT: 901066615 será la responsable del tratamiento y, en tal virtud, podrá recolectar, almacenar, y usar los datos personales de los pacientes como antecedentes personales y familiares Nombres, apellidos, edad, identificación, número de contacto, género, fecha de nacimiento, correo electrónico y otros que fuesen necesarios para el correcto diligenciamiento de la historia clínica y la realización de procedimientos asistenciales de Toma y procesamiento de muestras de laboratorio clínico.',
    'La IPS ACR VITAL LABORAL SAS, identificada con NIT: 901066615, será la responsable del tratamiento y, en tal virtud, podrá recolectar, almacenar y usar los datos personales de los pacientes, como antecedentes personales y familiares, nombres, apellidos, edad, identificación, número de contacto, género, fecha de nacimiento, correo electrónico y otros que fuesen necesarios para el correcto diligenciamiento de la historia clínica y la realización de procedimientos asistenciales de toma y procesamiento de muestras de laboratorio clínico.');
  replaceText(t, 'Manifiesto que me informaron que en caso de recolección de mi información sensible como la de mi estado de salud, tengo derecho a contestar o no las preguntas que me formulen y a entregar o no los datos solicitados.',
    'Manifiesto que me informaron que, en caso de recolección de mi información sensible, como la relativa a mi estado de salud, tengo derecho a contestar o no las preguntas que me formulen y a entregar o no los datos solicitados.');
  replaceText(t, 'Entiendo que son datos sensibles aquellos que afectan la intimidad del Titular o cuyo uso indebido puede generar discriminación como el estado de salud.',
    'Entiendo que son datos sensibles aquellos que afectan la intimidad del titular o cuyo uso indebido puede generar discriminación, como el estado de salud.');
  replaceText(t, 'Manifiesto que me informaron que los datos sensibles que se recolectarán serán utilizados para el adecuado diligenciamiento de la historia clínica en la IPS ACR VITAL LABORAL SAS.',
    'Manifiesto que me informaron que los datos sensibles que se recolectarán serán utilizados únicamente para el adecuado diligenciamiento de la historia clínica en la IPS ACR VITAL LABORAL SAS, bajo reserva.');
  replaceText(t, 'Sus derechos como titular del dato son los previstos en La Constitución y en la Ley 1581 de 2012, especialmente los siguientes:',
    'Sus derechos como titular del dato son los previstos en la Constitución y en la Ley 1581 de 2012, especialmente los siguientes:');
  replaceText(t, 'f) Abstenerse de responder las preguntas sobre datos sensibles o sobre datos de las niñas y niños y adolescentes.',
    'f) Abstenerse de responder las preguntas sobre datos sensibles o sobre datos de los niños, niñas y adolescentes.');
  replaceText(t, `Estos derechos los podré ejercer a través de los canales o medios dispuestos por la IPS ACR VITAL LABORAL SAS, para la atención al público, el correo electrónico: acrvitallaboralsas@gmail.com y en las instalaciones de la IPS ${address} Tocancipá.`,
    `Estos derechos los podré ejercer a través de los canales o medios dispuestos por la IPS ACR VITAL LABORAL SAS para la atención al público, el correo electrónico: acrvitallaboralsas@gmail.com y en las instalaciones de la IPS ${address}, Tocancipá.`);
  replaceText(t, 'Por todo lo anterior, he otorgado mi consentimiento a la IPS ACR VITAL LABORAL SAS, para que trate mi información personal de acuerdo con la Política de Tratamiento de Datos Personales.',
    'Por todo lo anterior, otorgo mi autorización a la IPS ACR VITAL LABORAL SAS para que trate mi información personal de acuerdo con la Política de Tratamiento de Datos Personales.');

  // Desistimiento: con formatos propios para menores, el de adultos es en nombre propio.
  replaceText(t, 'Yo, el (la) abajo firmante, identificado(a) como aparece al pie de mi firma, actuando en nombre propio o como representante legal del paciente, declaro que he sido informado(a) de la naturaleza y riesgos del procedimiento propuesto, manifiesto de forma libre y consciente mi DESISTIMIENTO para su realización, haciéndome responsable de las consecuencias que puedan derivarse de esta decisión.',
    'Yo, el (la) abajo firmante, identificado(a) como aparece al pie de mi firma, actuando en nombre propio, declaro que he sido informado(a) de la naturaleza y riesgos del procedimiento propuesto y manifiesto de forma libre y consciente mi DESISTIMIENTO para su realización, haciéndome responsable de las consecuencias que puedan derivarse de esta decisión.');

  t.blocks.push(p(MARCO_ADULTOS, { emphasis: 'italic' }));
  t.fields.push({ key: 'motivo_desistimiento', label: 'Motivo del desistimiento', input: 'text', required: false, decision: 'decline' });
  t.audience = 'adult';
  t.effectiveDate = EFFECTIVE;
}

const IMPLICACIONES_ANTES = [
  'Calidad de la muestra: La calidad', 'Exactitud de los resultados: Una toma', 'Seguridad del paciente: Un acto', 'Cumplimiento normativo: Existen normativas', 'Experiencia del paciente: La experiencia',
];

function lowercaseAfterColon(t) {
  // "Calidad de la muestra: La calidad…" → "…: la calidad…" (como en la revisión).
  for (const block of t.blocks) {
    if (block.type !== 'list') continue;
    block.items = block.items.map((item) => {
      const prefix = IMPLICACIONES_ANTES.find((start) => item.startsWith(start));
      if (!prefix) return item;
      const i = prefix.indexOf(': ') + 2;
      return item.slice(0, i) + item[i].toLowerCase() + item.slice(i + 1);
    });
  }
}

function adult(code) {
  return JSON.parse(readFileSync(path.join(TEMPLATES, `${code}.json`), 'utf8'));
}

const caF14 = adult('CA-F-14');
caF14.version = '1.2';
updateAdultCommon(caF14, ADDRESS_CALLE);
replaceText(caF14, 'Señor usuario para la toma de muestras no se debe haber ingerido alimentos en las últimas 10 y preferiblemente 12 horas. No ingerir bebidas alcohólicas antes de 72 horas. Si no está en ayunas, comuníquelo al personal que le atiende. En algunos casos no es necesario estar en ayunas y podrán realizarse los análisis, en otros casos se registrará esos datos en el interrogatorio de pacientes para tenerlo en cuenta a la hora de interpretar los resultados. Una información incorrecta puede llevar a conclusiones erróneas sobre su estado de salud. Su colaboración es necesaria, usted es el primer interesado. El material utilizado para extraer la sangre es estéril y desechable por lo que no existe riesgo de infección.',
  'Señor usuario: para la toma de muestras no se deben haber ingerido alimentos en las últimas 10 y preferiblemente 12 horas. No ingerir bebidas alcohólicas en las 72 horas previas. Si no está en ayunas, comuníquelo al personal que le atiende. En algunos casos no es necesario estar en ayunas y podrán realizarse los análisis; en otros casos se registrarán esos datos en el interrogatorio para tenerlos en cuenta a la hora de interpretar los resultados. Una información incorrecta puede llevar a conclusiones erróneas sobre su estado de salud; su colaboración es necesaria, usted es el primer interesado. El material utilizado para extraer la sangre es estéril y desechable, por lo que no existe riesgo de infección por el material.');
replaceText(caF14, 'La Venopunción es un procedimiento frecuente en el laboratorio clínico para la obtención de muestras de suero, plasma y sangre total, los cuales son importantes para realizar análisis paraclínicos y cuyos reportes son de ayuda para el médico tratante en el momento de esclarecer diagnósticos, monitorizar afecciones de salud crónicos o en forma preventiva.',
  'La venopunción es un procedimiento frecuente en el laboratorio clínico para la obtención de muestras de suero, plasma y sangre total, las cuales son importantes para realizar análisis paraclínicos y cuyos reportes son de ayuda para el médico tratante en el momento de esclarecer diagnósticos, monitorizar afecciones de salud crónicas o en forma preventiva.');
replaceText(caF14, 'Obtener una parte representativa de sangre para realizar un estudio en el Laboratorio clínico.', 'Obtener una parte representativa de sangre para realizar un estudio en el laboratorio clínico.');
replaceText(caF14, 'Puede presentar una discreta hinchazón, estas molestias menores son poco frecuentes y no requieren tratamiento ni medicación específica.', 'Puede presentarse una discreta hinchazón; estas molestias menores son poco frecuentes y no requieren tratamiento ni medicación específica.');
replaceText(caF14, 'En el momento de la toma de muestra de sangre por Venopunción, sentirá un leve dolor tipo pinchazo.', 'En el momento de la toma de muestra de sangre por venopunción sentirá un leve dolor tipo pinchazo.');
replaceText(caF14, 'En casos esporádicos se podrían presentar complicaciones de este procedimiento, como hematoma y/o dolor leve, los cuales mejorarán espontáneamente o con medidas locales.', 'En casos esporádicos se podrían presentar complicaciones como hematoma y/o dolor leve, los cuales mejorarán espontáneamente o con medidas locales.');
replaceText(caF14, 'En casos excepcionales, este dolor podría ser más severo y persistente o presentarse inflamación de la vena, infección o trombosis localizadas. Ocasionalmente en estos casos incluso se requerirá valoración médica para definir el manejo de acuerdo con la complicación presentada.', 'En casos excepcionales, este dolor podría ser más severo y persistente o presentarse inflamación de la vena, infección o trombosis localizadas. Ocasionalmente, en estos casos se requerirá valoración médica para definir el manejo de acuerdo con la complicación presentada.');
replaceText(caF14, 'En ocasiones puede ocurrir un difícil acceso a la vena lo que genera una nueva punción o un hematoma (acumulación de sangre causada por una ruptura de los vasos sanguíneos).', 'En ocasiones puede ocurrir un difícil acceso a la vena, lo que genera una nueva punción o un hematoma (acumulación de sangre causada por una ruptura de los vasos sanguíneos).');
replaceText(caF14, 'Al momento de la toma de la muestra puede presentarse: náusea, mareo y sensación de debilidad y en algunos pacientes se puede generar lipotimia que es un desmayo que puede causar o no la pérdida del conocimiento y su recuperación es rápida y completa.', 'Al momento de la toma de la muestra puede presentarse náusea, mareo y sensación de debilidad, y en algunos pacientes se puede generar lipotimia, que es un desmayo que puede causar o no la pérdida del conocimiento y cuya recuperación es rápida y completa.');
replaceText(caF14, 'Una vez recibido el consentimiento informado se entrega archivo para que haga parte integral de la historia clínica del paciente.', 'Una vez recibido el consentimiento informado, se archiva para que haga parte integral de la historia clínica del paciente.');
lowercaseAfterColon(caF14);

const caF15 = adult('CA-F-15');
caF15.version = '1.1';
updateAdultCommon(caF15, ADDRESS_CRA);
replaceText(caF15, 'Se puede producir molestias, náuseas y ganas de toser, pero solo dura unos cuantos segundos.', 'Se pueden producir molestias, náuseas y ganas de toser, pero solo duran unos cuantos segundos.');
replaceText(caF15, 'La IPS ACR VITAL LABORAL SAS mantiene absoluta confidencialidad sobre sus resultados, queda una copia de los mismos en el sistema informático. El acceso a ese sistema está protegido para que no pueda ser consultado por otras personas.',
  'La IPS ACR VITAL LABORAL SAS mantiene absoluta confidencialidad sobre sus resultados; queda una copia de los mismos en el sistema informático, cuyo acceso está protegido para que no pueda ser consultado por personas no autorizadas.');
replaceText(caF15, 'El procedimiento de Frotis Faríngeo se realiza de forma segura y es la opción comúnmente utilizada para posterior realización del procesamiento de la muestra, sin embargo, es un procedimiento seguro siempre y cuando se emplee la técnica correcta y los insumos seguros y confiables.',
  'El procedimiento de frotis faríngeo es la opción comúnmente utilizada para el posterior procesamiento de la muestra, y es un procedimiento seguro siempre y cuando se emplee la técnica correcta y los insumos seguros y confiables.');
replaceText(caF15, 'El cumplimiento de las recomendaciones por parte de la profesional (Bacterióloga) antes, durante y después del procedimiento de Frotis Faríngeo son de gran importancia para acatar por parte del paciente y para lograr los resultados esperados.',
  'El cumplimiento de las recomendaciones dadas por la profesional (bacterióloga) antes, durante y después del procedimiento de frotis faríngeo es de gran importancia para lograr los resultados esperados.');
replaceText(caF15, 'Es importante que la profesional (Bacterióloga) explique todos estos aspectos al paciente, responda a todas sus preguntas y se asegure que el paciente comprenda completamente el procedimiento de Frotis, beneficios, riesgos/complicaciones, alternativas antes de obtener el consentimiento informado para realizar el procedimiento. El paciente tiene el derecho de aceptar o rechazar la realización del Frotis Faríngeo después de recibir toda la información necesaria.',
  'Es importante que la profesional (bacterióloga) explique todos estos aspectos al paciente, responda todas sus preguntas y se asegure de que comprenda completamente el procedimiento de frotis, sus beneficios, riesgos/complicaciones y alternativas antes de obtener el consentimiento informado. El paciente tiene derecho a aceptar o rechazar la realización del frotis faríngeo después de recibir toda la información necesaria.');
{
  const reco = caF15.blocks.find((b) => b.type === 'list' && b.items.includes('Selección de insumos que cumplan con criterios de calidad.'));
  if (!reco) throw new Error('CA-F-15: no se encontró la lista de recomendaciones');
  reco.items.push('Explicar al paciente, antes de iniciar y en lenguaje sencillo, en qué consiste el procedimiento y cuánto dura.');
}

const caF35 = adult('CA-F-35');
caF35.version = '1.1';
updateAdultCommon(caF35, ADDRESS_CALLE);
replaceText(caF35, 'El test de drogas es un examen realizado a partir de una muestra de orina para detectar en el organismo la presencia de sustancias psicoactivas. Es importante que usted como paciente informe al profesional de la salud sobre los medicamentos que ha consumido hoy y en los días previos a la toma de este examen y entienda que un resultado positivo de esta prueba, indica con alta probabilidad, de la presencia de ésta(s) sustancia(s) en el organismo.',
  'El test de drogas es un examen realizado a partir de una muestra de orina para detectar en el organismo la presencia de sustancias psicoactivas. Es importante que usted como paciente informe al profesional de la salud sobre los medicamentos que ha consumido hoy y en los días previos a la toma de este examen, y entienda que un resultado positivo de esta prueba indica, con alta probabilidad, la presencia de esta(s) sustancia(s) en el organismo.');
replaceText(caF35, 'Existen varias pruebas de laboratorio diseñadas para este propósito las cuales se dividen básicamente en dos tipos: Presuntivas: que en caso de ser positivas indican una posible presencia de las sustancias psicoactivas y Confirmatorias. La prueba que se realizará inicialmente será de tipo presuntivo y en caso de salir positiva o indeterminada se realiza una prueba confirmatoria.',
  'Existen varias pruebas de laboratorio diseñadas para este propósito, las cuales se dividen básicamente en dos tipos: presuntivas, que en caso de ser positivas indican una posible presencia de las sustancias psicoactivas, y confirmatorias. La prueba que se realizará inicialmente será de tipo presuntivo y, en caso de salir positiva o indeterminada, se realizará una prueba confirmatoria.');
replaceText(caF35, 'A partir de una muestra de orina efectuar las pruebas necesarias para detectar en el organismo la presencia de sustancias psicoactivas, tales como marihuana, cocaína, bazuco, anfetaminas (éxtasis), benzodiacepinas (pepas), opiáceos (heroína) y sustancias similares o derivadas.',
  'A partir de una muestra de orina, efectuar las pruebas necesarias para detectar en el organismo la presencia de sustancias psicoactivas, tales como marihuana, cocaína, bazuco, anfetaminas (éxtasis), benzodiacepinas (pepas), opiáceos (heroína) y sustancias similares o derivadas.');
replaceText(caF35, 'Ninguna conocida para el paciente.', 'Ninguno directo derivado de la toma de la muestra.');
replaceText(caF35, 'Por ser realizada a partir de una muestra de orina el procedimiento no presenta riesgos para la salud.', 'Por ser realizada a partir de una muestra de orina, el procedimiento no presenta riesgos para la salud.');
replaceText(caF35, 'Una vez recibido el consentimiento informado se entrega archivo para que haga parte integral de la historia clínica del paciente.', 'Una vez recibido el consentimiento informado, se archiva para que haga parte integral de la historia clínica del paciente.');
lowercaseAfterColon(caF35);

// =====================================================================================
// Salida
// =====================================================================================

const ALL = [
  [caF14, 'caF14', 'CA_F_14'],
  [caF15, 'caF15', 'CA_F_15'],
  [caF35, 'caF35', 'CA_F_35'],
  [labFVih, 'labFVih', 'LAB_F_VIH'],
  [caF14M, 'caF14M', 'CA_F_14_M'],
  [caF15M, 'caF15M', 'CA_F_15_M'],
  [caF35M, 'caF35M', 'CA_F_35_M'],
  [labFVihM, 'labFVihM', 'LAB_F_VIH_M'],
];

for (const [template, file, constant] of ALL) {
  // Orden de claves estable: code, version, title, examType, audience, effectiveDate, …
  const ordered = {
    code: template.code,
    version: template.version,
    title: template.title,
    examType: template.examType,
    audience: template.audience,
    effectiveDate: template.effectiveDate,
    blocks: template.blocks,
    fields: template.fields,
    signatures: template.signatures,
    footer: template.footer,
    decision: template.decision,
  };
  const json = JSON.stringify(ordered, null, 2);
  writeFileSync(path.join(TEMPLATES, `${template.code}.json`), json + '\n');
  writeFileSync(
    path.join(APP_DATA, `${file}.ts`),
    `/**
 * ${template.code} v${template.version} — copia de respaldo incluida en el APK.
 *
 * GENERADO desde \`API GATEWAY/templates/${template.code}.json\` (la fuente que se publica en AWS)
 * por \`templates/borradores/build-2026-10.mjs\`. No editar a mano: cambiar el JSON,
 * publicarlo, y regenerar esta copia en la próxima versión del APK. La app solo la
 * usa si la tablet nunca ha descargado las plantillas (sin conexión desde la instalación).
 */
export const ${constant} = ${json} as const;
`
  );
  console.log(`${template.code} v${template.version}  (${template.audience})  ${template.fields.length} campos · ${template.signatures.length} firmas`);
}
