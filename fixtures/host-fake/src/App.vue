<template>
  <v-app>
    <v-btn data-testid="checkout-submit" @click="submit">Place order</v-btn>
    <v-alert v-if="error" data-testid="checkout-error">{{ error }}</v-alert>
  </v-app>
</template>
