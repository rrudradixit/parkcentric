const int sensorPin = 2;

void setup() {
  pinMode(sensorPin, INPUT);
  Serial.begin(9600);
}

void loop() {
  int v = digitalRead(sensorPin);
  if (v == LOW) Serial.println("OCCUPIED");
  else Serial.println("EMPTY");
  delay(200);
}