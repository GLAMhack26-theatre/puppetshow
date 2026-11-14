import cupPhoto from "../../assets/digital.skkg.ch/Becher_48468.21.jpg?url";
import cupModel from "../../assets/digital.skkg.ch/requisits/Becher_48468.21.glb?url";
import bedPhoto from "../../assets/digital.skkg.ch/Bett_44012.jpg?url";
import bedModel from "../../assets/digital.skkg.ch/requisits/Bett_44012.glb?url";
import dogPhoto from "../../assets/digital.skkg.ch/Hund_38872.24.jpg?url";
import dogModel from "../../assets/digital.skkg.ch/requisits/Hund_38872.24.glb?url";
import catPhoto from "../../assets/digital.skkg.ch/Katze_29404.202.jpg?url";
import catModel from "../../assets/digital.skkg.ch/requisits/Katze_29404.202.glb?url";
import ballPhoto from "../../assets/digital.skkg.ch/Kugel_38896.3.jpg?url";
import ballModel from "../../assets/digital.skkg.ch/requisits/Kugel_38896.3.glb?url";
import chairPhoto from "../../assets/digital.skkg.ch/Stuhl_25210.6.jpg?url";
import chairModel from "../../assets/digital.skkg.ch/requisits/Stuhl_25210.6.glb?url";
import frogPhoto from "../../assets/digital.skkg.ch/Frosch_49790_1.jpg?url";
import frogModel from "../../assets/digital.skkg.ch/Frosch_49790_v3.glb?url";
import marionettePhoto from "../../assets/digital.skkg.ch/marionettenpuppe-46154-2048px.jpg?url";

/** The SKKG collection objects used in the project (slide 1). */
export interface CollectionObject {
  title: string;
  inventory: string;
  photo: string;
  /** null: the marionette, loaded with its rig fixes (puppet/marionette.ts) */
  model: string | null;
}

export const OBJECTS: CollectionObject[] = [
  { title: "Marionette", inventory: "46154", photo: marionettePhoto, model: null },
  { title: "Cup", inventory: "48468.21", photo: cupPhoto, model: cupModel },
  { title: "Bed", inventory: "44012", photo: bedPhoto, model: bedModel },
  { title: "Dog", inventory: "38872.24", photo: dogPhoto, model: dogModel },
  { title: "Cat", inventory: "29404.202", photo: catPhoto, model: catModel },
  { title: "Ball", inventory: "38896.3", photo: ballPhoto, model: ballModel },
  { title: "Chair", inventory: "25210.6", photo: chairPhoto, model: chairModel },
  { title: "Frog", inventory: "49790", photo: frogPhoto, model: frogModel },
];
