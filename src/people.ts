// Generated profiles for pedestrians. Mostly Bulgarian names, with a few visitors.

import { pick, randInt, type Rng } from './rng';

export interface Profile {
  firstName: string;
  lastName: string;
  age: number;
  occupation: string;
  sex: 'male' | 'female'; // picks the silhouette in the inspector
}

const MALE_FIRST = [
  'Georgi', 'Ivan', 'Dimitar', 'Nikolay', 'Petar', 'Hristo', 'Stoyan', 'Aleksandar', 'Todor', 'Martin',
  'Kaloyan', 'Borislav', 'Viktor', 'Yordan', 'Stefan', 'Plamen', 'Vasil', 'Emil', 'Krasimir', 'Radoslav',
  'Angel', 'Lyubomir', 'Tsvetan', 'Boyan', 'Asen', 'Ognyan', 'Valentin', 'Simeon',
];
const FEMALE_FIRST = [
  'Maria', 'Ivana', 'Elena', 'Desislava', 'Yordanka', 'Gergana', 'Viktoriya', 'Petya', 'Nadezhda', 'Teodora',
  'Ralitsa', 'Svetlana', 'Daniela', 'Mila', 'Kristina', 'Radka', 'Boryana', 'Simona', 'Tsvetelina', 'Nikol',
  'Antoaneta', 'Vesela', 'Zornitsa', 'Galina', 'Lyudmila', 'Siyana', 'Rumyana', 'Yana',
];
// Male form; the female form adds "a" (Ivanov / Ivanova).
const SURNAMES = [
  'Ivanov', 'Georgiev', 'Dimitrov', 'Petrov', 'Nikolov', 'Hristov', 'Stoyanov', 'Todorov', 'Iliev', 'Vasilev',
  'Atanasov', 'Petkov', 'Angelov', 'Kolev', 'Yordanov', 'Marinov', 'Popov', 'Stefanov', 'Mihaylov', 'Kostov',
  'Dobrev', 'Zhelev', 'Penev', 'Slavov', 'Rusev', 'Bozhilov', 'Kirilov', 'Tsvetkov', 'Rangelov', 'Mladenov',
];
const VISITORS = {
  male: ['James', 'Lukas', 'Marco', 'Tom', 'Mateusz', 'Kenji'],
  female: ['Emma', 'Sofia', 'Anna', 'Chloé', 'Ingrid', 'Leila'],
  last: ['Smith', 'Müller', 'Rossi', 'Novak', 'Kowalski', 'Dubois', 'Jensen', 'Tanaka', 'García', 'Brown', 'Haddad'],
};

const OCCUPATIONS: { title: string; age: [number, number] }[] = [
  { title: 'Barista', age: [19, 35] },
  { title: 'Software developer', age: [22, 50] },
  { title: 'University student', age: [18, 26] },
  { title: 'High school student', age: [15, 18] },
  { title: 'Retired teacher', age: [63, 84] },
  { title: 'Retired engineer', age: [63, 84] },
  { title: 'Nurse', age: [22, 60] },
  { title: 'Street musician', age: [18, 60] },
  { title: 'Food courier', age: [18, 40] },
  { title: 'Architect', age: [26, 65] },
  { title: 'Accountant', age: [24, 64] },
  { title: 'Lawyer', age: [26, 66] },
  { title: 'Waiter', age: [18, 45] },
  { title: 'Florist', age: [20, 65] },
  { title: 'Bank clerk', age: [22, 60] },
  { title: 'Journalist', age: [23, 62] },
  { title: 'Photographer', age: [20, 60] },
  { title: 'Pharmacist', age: [25, 65] },
  { title: 'Tour guide', age: [20, 55] },
  { title: 'Electrician', age: [20, 62] },
  { title: 'Shop assistant', age: [17, 55] },
  { title: 'Civil servant', age: [24, 64] },
  { title: 'Graphic designer', age: [21, 50] },
  { title: 'University lecturer', age: [30, 70] },
  { title: 'Construction worker', age: [19, 62] },
  { title: 'Dentist', age: [27, 66] },
  { title: 'Chef', age: [20, 60] },
  { title: 'Fitness trainer', age: [20, 45] },
  { title: 'Taxi driver (on a break)', age: [25, 66] },
  { title: 'Between jobs', age: [18, 64] },
];

const VISITOR_SHARE = 0.12;

export function randomProfile(rnd: Rng): Profile {
  if (rnd() < VISITOR_SHARE) {
    const female = rnd() < 0.5;
    return {
      firstName: pick(rnd, female ? VISITORS.female : VISITORS.male),
      lastName: pick(rnd, VISITORS.last),
      age: randInt(rnd, [20, 72]),
      occupation: 'Tourist',
      sex: female ? 'female' : 'male',
    };
  }
  const female = rnd() < 0.5;
  const job = pick(rnd, OCCUPATIONS);
  const surname = pick(rnd, SURNAMES);
  return {
    firstName: pick(rnd, female ? FEMALE_FIRST : MALE_FIRST),
    lastName: female ? `${surname}a` : surname,
    age: randInt(rnd, job.age),
    occupation: job.title,
    sex: female ? 'female' : 'male',
  };
}
